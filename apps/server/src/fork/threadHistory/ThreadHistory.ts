/**
 * Fork: a thread settled for an hour is uploaded to the configured store (`blobStore.ts`; off
 * without it), verified, then removed locally, in a new blob each time. `ensureLocal` restores
 * before any read or command that needs history; an expired blob leaves a stub, and an
 * unreachable store fails the read so the client retries.
 */
import type { ForkThreadHistoryStatus, ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import {
  asBlobError,
  azureHistoryBlobStore,
  type HistoryBlobStore,
  HistoryBlobUnavailable,
  readHistoryStoreConfig,
  sha256Hex,
} from "./blobStore.ts";
import * as HistoryStore from "./historyStore.ts";

/**
 * Commands that only rewrite the thread row (read state, pins, title, pull
 * request links, snooze, settle, archive, delete) leave an offloaded thread
 * where it is; background syncs send them to settled threads all day.
 */
const COMMANDS_WITHOUT_HISTORY = new Set([
  "thread.visit",
  "thread.mark-unread",
  "thread.pin",
  "thread.unpin",
  "thread.pin.reorder",
  "thread.active.reorder",
  "thread.metadata.update",
  "thread.title.regeneration.complete",
  "thread.pull-request.link",
  "thread.pull-request.unlink",
  "thread.pull-request.sync",
  "thread.pull-request.watch",
  "thread.pull-request-link.sync",
  "thread.pull-request-watch.sync",
  "thread.snooze",
  "thread.unsnooze",
  "thread.settle",
  "thread.archive",
  "thread.delete",
]);

export class ThreadHistory extends Context.Service<
  ThreadHistory,
  {
    /** Brings an offloaded thread's history back before it is read or used. */
    readonly ensureLocal: (
      threadId: ThreadId,
      commandType?: string,
    ) => Effect.Effect<void, HistoryBlobUnavailable>;
    /** Where the thread's history is, then every change; subscribing restores it. */
    readonly watch: (threadId: ThreadId) => Stream.Stream<ForkThreadHistoryStatus>;
    /** Offloads every thread that may move now; the scheduler calls it. */
    readonly sweep: (environmentId: string) => Effect.Effect<void>;
  }
>()("t3/fork/threadHistory/ThreadHistory") {}

export const make = Effect.fn("ThreadHistory.make")(function* (blobs: HistoryBlobStore | null) {
  const store = yield* HistoryStore.make;
  const locks = yield* KeyedLock.make<ThreadId>();
  const changes = yield* PubSub.unbounded<ThreadId>();
  // The hot path (every read and dispatch) only consults this set.
  const offloaded = new Set((yield* store.records.pipe(Effect.orDie)).map((r) => r.threadId));
  const transient = new Map<ThreadId, ForkThreadHistoryStatus>();

  const statusOf = Effect.fn("ThreadHistory.statusOf")(function* (threadId: ThreadId) {
    const current = transient.get(threadId);
    if (current !== undefined) return current;
    if (!offloaded.has(threadId)) return { state: "local" } as const;
    const record = yield* store.record(threadId).pipe(Effect.orDie);
    if (record === null) return { state: "local" } as const;
    return record.expiredAt === null
      ? ({ state: "restoring", offloadedAt: record.offloadedAt } as const)
      : ({ state: "expired", offloadedAt: record.offloadedAt } as const);
  });

  const announce = Effect.fn("ThreadHistory.announce")(function* (
    threadId: ThreadId,
    status: ForkThreadHistoryStatus | null,
  ) {
    if (status === null) transient.delete(threadId);
    else transient.set(threadId, status);
    yield* PubSub.publish(changes, threadId);
  });

  const download = (name: string, sha256: string) =>
    Effect.tryPromise({
      try: () => {
        if (blobs === null) {
          throw new HistoryBlobUnavailable({ message: "thread history storage is off" });
        }
        return blobs.get(name);
      },
      catch: asBlobError,
    }).pipe(
      Effect.filterOrFail(
        (body) => sha256Hex(body) === sha256,
        () =>
          new HistoryBlobUnavailable({ message: "the downloaded history failed its hash check" }),
      ),
    );

  const restore = (threadId: ThreadId) =>
    locks.withLock(
      threadId,
      Effect.gen(function* () {
        if (!offloaded.has(threadId)) return;
        const record = yield* store.record(threadId).pipe(Effect.orDie);
        if (record === null || record.expiredAt !== null) {
          if (record === null) offloaded.delete(threadId);
          return;
        }
        yield* announce(threadId, { state: "restoring", offloadedAt: record.offloadedAt });
        const bytes = yield* download(record.blobName, record.sha256);
        yield* store.restoreLocal(HistoryStore.decodeBundle(bytes)).pipe(
          Effect.tapCause((cause) =>
            Effect.logWarning("restoring thread history failed", { threadId, cause }),
          ),
          Effect.mapError(
            () => new HistoryBlobUnavailable({ message: "writing it back to this machine failed" }),
          ),
        );
        offloaded.delete(threadId);
        yield* Effect.logInfo("restored settled thread history from Azure", {
          threadId,
          events: record.eventCount,
        });
        yield* announce(threadId, null);
      }).pipe(
        Effect.catchTags({
          HistoryBlobMissing: () =>
            store
              .markExpired(threadId)
              .pipe(Effect.orDie, Effect.andThen(announce(threadId, null))),
        }),
        Effect.tapError((error) =>
          announce(threadId, { state: "unavailable", message: error.message }),
        ),
        Effect.mapError(
          (error) =>
            new HistoryBlobUnavailable({
              message: `This thread's history is in Azure and could not be restored (${error.message}). Open it again to retry.`,
            }),
        ),
      ),
    );

  const ensureLocal: ThreadHistory["Service"]["ensureLocal"] = (threadId, commandType) =>
    !offloaded.has(threadId) ||
    (commandType !== undefined && COMMANDS_WITHOUT_HISTORY.has(commandType))
      ? Effect.void
      : restore(threadId);

  const watch: ThreadHistory["Service"]["watch"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        // Watching is opening the thread: start the restore beside the stream.
        yield* restore(threadId).pipe(Effect.ignore, Effect.forkDetach);
        return Stream.concat(
          Stream.fromEffect(statusOf(threadId)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
            Stream.mapEffect(() => statusOf(threadId)),
          ),
        );
      }),
    );

  const offloadOne = (environmentId: string) => (threadId: ThreadId) =>
    locks
      .withLock(
        threadId,
        Effect.gen(function* () {
          if (blobs === null || (yield* store.refusal(threadId)) !== null) return "skipped";
          yield* Effect.tryPromise({ try: () => blobs.ready(), catch: asBlobError });
          const { bundle, localBytes, lastSequence } = yield* store.collect(threadId);
          if (bundle.events.length === 0) return "skipped";
          const body = HistoryStore.encodeBundle(bundle);
          const sha256 = sha256Hex(body);
          const now = DateTime.formatIso(yield* DateTime.now);
          // Hashed: thread ids can run past Azure's 1,024-character blob name limit.
          const blobName = `${environmentId}/${sha256Hex(new TextEncoder().encode(threadId))}/${now}.json.gz`;
          // Verify-then-delete: read the upload back before anything local goes.
          yield* Effect.tryPromise({ try: () => blobs.put(blobName, body), catch: asBlobError });
          yield* download(blobName, sha256);
          const removed = yield* store.removeLocal({
            threadId,
            blobName,
            sha256,
            eventCount: bundle.events.length,
            lastSequence,
            localBytes,
            blobBytes: body.byteLength,
          });
          if (!removed) return "skipped";
          offloaded.add(threadId);
          yield* store.releaseFreePages;
          yield* Effect.logInfo("moved settled thread history to Azure", {
            threadId,
            events: bundle.events.length,
            localBytes,
            blobBytes: body.byteLength,
          });
          return "moved";
        }),
      )
      .pipe(
        // Azure refusing or unreachable stops the pass (see `sweep`); anything else
        // only skips this thread.
        Effect.catchTags({
          HistoryBlobMissing: (error) =>
            Effect.logWarning("history upload could not be read back", { threadId, error }).pipe(
              Effect.as("azure" as const),
            ),
          HistoryBlobUnavailable: (error) =>
            Effect.logWarning("Azure Blob Storage unusable; offloading paused", {
              threadId,
              error: error.message,
            }).pipe(Effect.as("azure" as const)),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("offloading settled thread history failed", { threadId, cause }).pipe(
            Effect.as("skipped" as const),
          ),
        ),
      );

  // Threads offloaded before run events stayed local list as working until
  // their runs come back; one download each puts back only those.
  const repairOne = (threadId: ThreadId) =>
    locks
      .withLock(
        threadId,
        Effect.gen(function* () {
          const record = yield* store.record(threadId);
          if (record === null || record.expiredAt !== null) return "skipped";
          const bytes = yield* download(record.blobName, record.sha256);
          yield* store.repairRuns(HistoryStore.decodeBundle(bytes));
          return "moved";
        }),
      )
      .pipe(
        Effect.catchTags({
          HistoryBlobMissing: () => store.markExpired(threadId).pipe(Effect.as("skipped" as const)),
          HistoryBlobUnavailable: (error) =>
            Effect.logWarning("Azure Blob Storage unusable; run repair paused", {
              threadId,
              error: error.message,
            }).pipe(Effect.as("azure" as const)),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("putting back run history failed", { threadId, cause }).pipe(
            Effect.as("skipped" as const),
          ),
        ),
      );

  // A tick with no commit, finished effect or ended grace period since the last full pass has
  // nothing to do; grace periods are checked every 10 minutes. After Azure fails, waiting threads
  // are not retried (that would rebuild bundles every tick) until a new settle or a restart.
  let sweptThrough = "";
  let pausedOn: string | null = null;
  const sweep = Effect.fn("ThreadHistory.sweep")(
    function* (environmentId: string) {
      const now = yield* Clock.currentTimeMillis;
      const latest = `${yield* store.changeMark}@${Math.floor(now / 600_000)}`;
      if (latest === sweptThrough) return;
      const repairs = yield* store.runsAway;
      const candidates = yield* store.candidates(now);
      const waiting = [...repairs, "", ...candidates].join("\n");
      if (waiting !== pausedOn) {
        pausedOn = null;
        const work = [
          ...repairs.map((threadId) => () => repairOne(threadId)),
          ...candidates.map((threadId) => () => offloadOne(environmentId)(threadId)),
        ];
        for (const step of work) {
          if ((yield* step()) === "azure") {
            pausedOn = waiting;
            break;
          }
        }
      }
      sweptThrough = latest;
    },
    Effect.catchCause((cause) => Effect.logWarning("thread history sweep failed", { cause })),
  );

  return ThreadHistory.of({ ensureLocal, watch, sweep });
});

/** `fork-thread-history.json` from the server's userdata dir (`stateDir`); null means off. */
const storeConfig = Effect.gen(function* () {
  return readHistoryStoreConfig((yield* ServerConfig.ServerConfig).stateDir);
});

export const layer = Layer.effect(
  ThreadHistory,
  Effect.gen(function* () {
    const config = yield* storeConfig;
    return yield* make(config === null ? null : azureHistoryBlobStore(config));
  }),
);

/** The offload sweep, on upstream's due-work scheduler; production only. */
export const layerSweep = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* storeConfig) === null) return;
    const history = yield* ThreadHistory;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    yield* (yield* Scheduler.Scheduler).register(
      "fork-thread-history-offload",
      history.sweep(environmentId),
    );
  }),
);

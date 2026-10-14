/**
 * Fork (Owner): settled threads keep their history in Azure Blob Storage.
 *
 * Offload: upstream's due-work scheduler runs the sweep; each settled or
 * archived thread that `historyStore.refusal` allows is bundled, uploaded,
 * downloaded again and hash-checked, and only then removed locally in one
 * transaction that re-checks the thread. Each offload writes a new blob, so a
 * thread settled again gets a fresh 60 days from the container's lifecycle
 * rule (FORK.md, "Settled threads in Azure").
 *
 * Restore: `ensureLocal` runs before every thread read and every command that
 * needs history (ThreadManagementService's transcript hook), so unsettling,
 * unarchiving, opening and sending all bring the history back first. A blob
 * the lifecycle rule deleted leaves the thread as its stub, marked expired;
 * Azure being unreachable fails the read so the client retries.
 */
import type { ForkThreadHistoryStatus, ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import {
  asBlobError,
  azureHistoryBlobStore,
  type HistoryBlobStore,
  HistoryBlobUnavailable,
  historySecretName,
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

export const make = (blobs: HistoryBlobStore | null) =>
  Effect.gen(function* () {
    const store = yield* HistoryStore.make;
    const locks = yield* KeyedLock.make<ThreadId>();
    const changes = yield* PubSub.unbounded<ThreadId>();
    // The hot path (every read and dispatch) only consults this set.
    const offloaded = new Set((yield* store.records.pipe(Effect.orDie)).map((r) => r.threadId));
    const transient = new Map<ThreadId, ForkThreadHistoryStatus>();

    const statusOf = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const current = transient.get(threadId);
        if (current !== undefined) return current;
        if (!offloaded.has(threadId)) return { state: "local" } as const;
        const record = yield* store.record(threadId).pipe(Effect.orDie);
        if (record === null) return { state: "local" } as const;
        return record.expiredAt === null
          ? ({ state: "restoring", offloadedAt: record.offloadedAt } as const)
          : ({ state: "expired", offloadedAt: record.offloadedAt } as const);
      });

    const announce = (threadId: ThreadId, status: ForkThreadHistoryStatus | null) =>
      Effect.gen(function* () {
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
              () =>
                new HistoryBlobUnavailable({ message: "writing it back to this machine failed" }),
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

    // Whether a thread may move only changes when an event commits or an effect
    // finishes, so a tick with neither since the last full pass has nothing to do.
    // After Azure fails, the same waiting threads are not tried again: retrying
    // would rebuild bundles every tick on a Mac that cannot reach Azure. A newly
    // settled thread, or a restart, tries again.
    let sweptThrough = "";
    let pausedOn: string | null = null;
    const sweep = (environmentId: string) =>
      Effect.gen(function* () {
        const latest = yield* store.changeMark;
        if (latest === sweptThrough) return;
        const candidates = yield* store.candidates;
        const waiting = candidates.join("\n");
        if (waiting !== pausedOn) {
          pausedOn = null;
          for (const threadId of candidates) {
            if ((yield* offloadOne(environmentId)(threadId)) === "azure") {
              pausedOn = waiting;
              break;
            }
          }
        }
        sweptThrough = latest;
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("thread history sweep failed", { cause })),
      );

    return ThreadHistory.of({ ensureLocal, watch, sweep });
  });

export const layer = Layer.effect(
  ThreadHistory,
  Effect.suspend(() => {
    const secret = historySecretName();
    return make(secret === null ? null : azureHistoryBlobStore(secret));
  }),
);

/** The offload sweep, on upstream's due-work scheduler; production only. */
export const layerSweep = Layer.effectDiscard(
  Effect.gen(function* () {
    if (historySecretName() === null) return;
    const history = yield* ThreadHistory;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    yield* (yield* Scheduler.Scheduler).register(
      "fork-thread-history-offload",
      history.sweep(environmentId),
    );
  }),
);

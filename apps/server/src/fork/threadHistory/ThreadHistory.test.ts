import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  HistoryBlobMissing,
  HistoryBlobRejected,
  HistoryBlobUnavailable,
  type HistoryBlobStore,
} from "./blobStore.ts";
import { MOVED_EVENT_TYPES } from "./historyStore.ts";
import * as ThreadHistory from "./ThreadHistory.ts";

const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerTest = Layer.mergeAll(EventSink.layer, ThreadSearch.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(layerStores),
);

const at = DateTime.makeUnsafe("2026-10-01T12:00:00Z");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId: providerInstanceId, model: "claude-opus-5-5" };
const projectId = ProjectId.make("project:history");

/**
 * A blob container in memory. `failNext` makes the next download fail like
 * Azure being down; `down` makes signing in fail, and `signIns` counts tries.
 * Like Azure, it refuses names over 1,024 characters; `rejectNext` refuses the
 * next upload.
 */
function memoryBlobs() {
  const blobs = new Map<string, Uint8Array>();
  const state = { failNext: false, down: false, signIns: 0, rejectNext: false };
  const store: HistoryBlobStore = {
    ready: async () => {
      state.signIns += 1;
      if (state.down) throw new HistoryBlobUnavailable({ message: "Azure sign-in failed" });
    },
    put: async (name, body) => {
      if (name.length > 1024 || state.rejectNext) {
        state.rejectNext = false;
        throw new HistoryBlobRejected({ message: "upload failed (400)" });
      }
      blobs.set(name, Uint8Array.from(body));
    },
    get: async (name) => {
      if (state.failNext) {
        state.failNext = false;
        throw new HistoryBlobUnavailable({ message: "Azure Blob Storage unreachable" });
      }
      const body = blobs.get(name);
      if (body === undefined) throw new HistoryBlobMissing({ message: name });
      return body;
    },
  };
  return { blobs, state, store };
}

const threadPayload = (
  threadId: ThreadId,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: `title of ${threadId}`,
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

/** A thread with one finished turn: three messages, a tool call with output, then settled. */
const settledThread = (
  name: string,
  options: {
    readonly runStatus?: OrchestrationV2Run["status"];
    readonly forkedFrom?: ThreadId;
    readonly settled?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`thread:${name}`);
    const runId = RunId.make(`run:${name}:1`);
    const status = options.runStatus ?? "completed";
    const message = (id: string, role: "user" | "assistant", text: string) =>
      ({
        id: EventId.make(`event:${name}:${id}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy: role === "user" ? "user" : "agent",
          creationSource: role === "user" ? "web" : "provider",
          id: MessageId.make(`message:${name}:${id}`),
          threadId,
          runId,
          nodeId: null,
          role,
          text,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      }) satisfies OrchestrationV2DomainEvent;
    const base = threadPayload(
      threadId,
      options.forkedFrom === undefined
        ? {}
        : {
            forkedFrom: {
              type: "run",
              threadId: options.forkedFrom,
              runId: RunId.make(`run:${options.forkedFrom.slice("thread:".length)}:1`),
            },
          },
    );
    const events: OrchestrationV2DomainEvent[] = [
      {
        id: EventId.make(`event:${name}:created`),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: base,
      },
      {
        id: EventId.make(`event:${name}:run`),
        type: "run.created",
        threadId,
        occurredAt: at,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:${name}:ask`),
          rootNodeId: null,
          activeAttemptId: null,
          status,
          requestedAt: at,
          startedAt: at,
          completedAt: status === "completed" ? at : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      message("ask", "user", "Please look at the billing ledger."),
      message(
        "middle",
        "assistant",
        `The reconciliation drift in ${name} comes from rounding half-cents.`,
      ),
      {
        id: EventId.make(`event:${name}:tool`),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: {
          id: TurnItemId.make(`item:${name}:tool`),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          type: "dynamic_tool",
          status: "completed",
          title: "query",
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          toolName: "sql",
          input: { query: "select * from ledger" },
          output: { rows: "x".repeat(20_000) },
        },
      },
      message("done", "assistant", "Fixed it."),
    ];
    if (options.settled !== false) {
      events.push({
        id: EventId.make(`event:${name}:settled`),
        type: "thread.settled",
        threadId,
        occurredAt: at,
        payload: { ...base, settledOverride: "settled", settledAt: at },
      });
    }
    yield* sink.write({ events });
    return threadId;
  });

const PROJECTION_TABLES = [
  "orchestration_v2_projection_threads",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_turn_item_positions",
];

/** Every projection row of the thread, and the payloads of its moved events. */
const snapshot = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables: Record<string, unknown> = {};
    for (const table of PROJECTION_TABLES) {
      tables[table] =
        yield* sql`SELECT * FROM ${sql(table)} WHERE thread_id = ${threadId} ORDER BY 1`;
    }
    const events = yield* sql<{ readonly event_id: string; readonly payload_json: string }>`
      SELECT event_id, payload_json FROM orchestration_events
      WHERE stream_id = ${threadId} AND event_type IN ${sql.in(MOVED_EVENT_TYPES)}
      ORDER BY sequence
    `;
    return { tables, events };
  });

const movedEventCount = (threadId: ThreadId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly n: number }>`
      SELECT count(*) AS n FROM orchestration_events
      WHERE stream_id = ${threadId} AND event_type IN ${sql.in(MOVED_EVENT_TYPES)}
    `.pipe(Effect.map((rows) => rows[0]!.n)),
  );

const firstStatus = (history: ThreadHistory.ThreadHistory["Service"], threadId: ThreadId) =>
  history.watch(threadId).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((all) => Array.from(all)[0]),
  );

it.layer(layerTest)("ThreadHistory", (it) => {
  it.effect("moves a settled thread's history out and brings it back identical", () =>
    Effect.gen(function* () {
      const blobs = memoryBlobs();
      const history = yield* ThreadHistory.make(blobs.store);
      const threadId = yield* settledThread("round-trip");
      const before = yield* snapshot(threadId);

      yield* history.sweep("env");

      assert.equal(blobs.blobs.size, 1);
      assert.equal(yield* movedEventCount(threadId), 0);
      const away = yield* snapshot(threadId);
      assert.lengthOf(away.tables["orchestration_v2_projection_turn_items"] as unknown[], 0);
      // The stub keeps the thread in lists.
      assert.lengthOf(away.tables["orchestration_v2_projection_threads"] as unknown[], 1);

      yield* history.ensureLocal(threadId);

      assert.deepEqual(yield* snapshot(threadId), before);
      assert.equal((yield* firstStatus(history, threadId))?.state, "local");
    }),
  );

  it.effect("still finds an offloaded thread by a phrase from the middle of it", () =>
    Effect.gen(function* () {
      const history = yield* ThreadHistory.make(memoryBlobs().store);
      const search = yield* ThreadSearch.ThreadSearch;
      yield* (yield* ProjectStore.ProjectStoreV2).apply({
        sequence: 0,
        eventId: EventId.make("event:project:history"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(at),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "history",
          workspaceRoot: "/work/history",
          defaultModelSelection: null,
          scripts: [],
          createdAt: DateTime.formatIso(at),
          updatedAt: DateTime.formatIso(at),
        },
      });
      const threadId = yield* settledThread("searchable");
      yield* history.sweep("env");
      assert.equal(yield* movedEventCount(threadId), 0);

      const result = yield* search.search({ query: "drift in searchable comes from rounding" });
      assert.deepEqual(
        result.matches.map((match) => match.threadId),
        [threadId],
      );
    }),
  );

  it.effect("keeps history local while a turn is running or a fork of it is open", () =>
    Effect.gen(function* () {
      const blobs = memoryBlobs();
      const history = yield* ThreadHistory.make(blobs.store);
      const running = yield* settledThread("running", { runStatus: "running" });
      const source = yield* settledThread("fork-source");
      yield* settledThread("open-fork", { forkedFrom: source, settled: false });

      yield* history.sweep("env");

      assert.isAbove(yield* movedEventCount(running), 0);
      assert.isAbove(yield* movedEventCount(source), 0);
      assert.equal(blobs.blobs.size, 0);
    }),
  );

  it.effect("metadata commands leave history away; sending a message brings it back", () =>
    Effect.gen(function* () {
      const history = yield* ThreadHistory.make(memoryBlobs().store);
      const threadId = yield* settledThread("commands");
      yield* history.sweep("env");

      yield* history.ensureLocal(threadId, "thread.visit");
      yield* history.ensureLocal(threadId, "thread.pull-request-link.sync");
      assert.equal(yield* movedEventCount(threadId), 0);

      yield* history.ensureLocal(threadId, "message.dispatch");
      assert.isAbove(yield* movedEventCount(threadId), 0);
    }),
  );

  it.effect("a blob the lifecycle rule deleted leaves the thread open as expired", () =>
    Effect.gen(function* () {
      const blobs = memoryBlobs();
      const history = yield* ThreadHistory.make(blobs.store);
      const threadId = yield* settledThread("expired");
      yield* history.sweep("env");
      blobs.blobs.clear();

      // Reading succeeds with the stub instead of failing forever.
      yield* history.ensureLocal(threadId);
      assert.equal((yield* firstStatus(history, threadId))?.state, "expired");
      assert.equal(yield* movedEventCount(threadId), 0);
    }),
  );

  it.effect("unreachable Azure fails the read as unavailable, and the next read restores", () =>
    Effect.gen(function* () {
      const blobs = memoryBlobs();
      const history = yield* ThreadHistory.make(blobs.store);
      const threadId = yield* settledThread("unavailable");
      yield* history.sweep("env");

      blobs.state.failNext = true;
      const error = yield* Effect.flip(history.ensureLocal(threadId));
      assert.include(error.message, "could not be restored");
      assert.equal(yield* movedEventCount(threadId), 0);

      yield* history.ensureLocal(threadId);
      assert.isAbove(yield* movedEventCount(threadId), 0);
    }),
  );

  it.effect("reading keeps it local; settling again uploads a new blob for a fresh 60 days", () =>
    Effect.gen(function* () {
      const blobs = memoryBlobs();
      const history = yield* ThreadHistory.make(blobs.store);
      const sink = yield* EventSink.EventSinkV2;
      const threadId = yield* settledThread("twice");
      yield* history.sweep("env");
      yield* history.ensureLocal(threadId);

      // Opened to read, still settled: it stays on this disk.
      yield* history.sweep("env");
      assert.isAbove(yield* movedEventCount(threadId), 0);
      assert.equal(blobs.blobs.size, 1);

      const again = threadPayload(threadId, {
        settledOverride: "settled",
        settledAt: DateTime.add(at, { days: 1 }),
      });
      for (const [type, payload] of [
        ["thread.unsettled", threadPayload(threadId, { settledOverride: "active" })],
        ["thread.settled", again],
      ] as const) {
        yield* sink.write({
          events: [
            { id: EventId.make(`event:twice:${type}`), type, threadId, occurredAt: at, payload },
          ],
        });
      }
      yield* TestClock.adjust("1 day");
      yield* history.sweep("env");

      assert.equal(blobs.blobs.size, 2);
      assert.equal(yield* movedEventCount(threadId), 0);
    }),
  );

  it.effect("pauses offloading after Azure fails, until another thread settles", () =>
    Effect.gen(function* () {
      const blobs = memoryBlobs();
      const history = yield* ThreadHistory.make(blobs.store);
      blobs.state.down = true;
      const first = yield* settledThread("paused-first");
      yield* history.sweep("env");
      assert.equal(blobs.state.signIns, 1);

      // New events elsewhere, same waiting threads: no new attempt.
      yield* settledThread("paused-busy", { settled: false });
      yield* history.sweep("env");
      assert.equal(blobs.state.signIns, 1);

      blobs.state.down = false;
      yield* settledThread("paused-second");
      yield* history.sweep("env");
      assert.equal(yield* movedEventCount(first), 0);
      assert.equal(blobs.blobs.size, 2);
    }),
  );

  it.effect(
    "a thread id longer than a blob name moves; a refused upload skips only its thread",
    () =>
      Effect.gen(function* () {
        const blobs = memoryBlobs();
        const history = yield* ThreadHistory.make(blobs.store);
        const long = yield* settledThread(`long-${"x".repeat(1_100)}`);
        yield* history.sweep("env");
        assert.equal(yield* movedEventCount(long), 0);

        blobs.state.rejectNext = true;
        const refused = yield* settledThread("refused-a");
        const next = yield* settledThread("refused-b");
        yield* history.sweep("env");
        const left = [yield* movedEventCount(refused), yield* movedEventCount(next)];
        assert.equal(left.filter((n) => n === 0).length, 1);
      }),
  );

  it.effect("gives the freed pages back to the disk", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
      yield* sql`VACUUM`;
      const history = yield* ThreadHistory.make(memoryBlobs().store);
      yield* settledThread("pages");
      yield* history.sweep("env");
      const rows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      assert.equal(rows[0]!.freelist_count, 0);
    }),
  );
});

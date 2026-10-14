/**
 * Fork (Owner): the local half of keeping settled threads' history in Azure.
 *
 * What moves: every event of a settled or archived thread except its
 * `thread.*` events (the stub: title, project, timestamps, lifecycle),
 * `message.updated` events (the plain user and assistant text, so search keeps
 * finding the thread by content) and `provider-session.*` events (their rows are
 * shared between threads), plus the projection rows those moved events wrote.
 * Measured on mac-a on 2026-10-13: the moved part is 473 MB of event JSON, the
 * kept message text about 18 MB.
 *
 * Restore puts the events back under new sequence numbers (so a client that
 * cached the stub receives them when it resumes) and rebuilds their projection
 * rows with the current code, so a projection schema change while the thread
 * was away cannot strand rows in an old shape. The thread row itself is never
 * removed, and is written back as it was after the replay.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeZlib from "node:zlib";

import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { threadHasQueuedTurnStart } from "../../orchestration-v2/ThreadSettlementService.ts";

/** Event types that move, with the projection table and key each one writes. */
const MOVED_EVENTS: Record<string, { table: string; key: string; id: string } | null> = {
  "run.created": { table: "runs", key: "run_id", id: "$.id" },
  "run.updated": { table: "runs", key: "run_id", id: "$.id" },
  "run.background-work-cancelled": { table: "runs", key: "run_id", id: "$.runId" },
  "run-attempt.created": { table: "run_attempts", key: "attempt_id", id: "$.id" },
  "run-attempt.updated": { table: "run_attempts", key: "attempt_id", id: "$.id" },
  "node.updated": { table: "nodes", key: "node_id", id: "$.id" },
  "subagent.updated": { table: "subagents", key: "subagent_id", id: "$.id" },
  "provider-thread.updated": { table: "provider_threads", key: "provider_thread_id", id: "$.id" },
  "provider-turn.updated": { table: "provider_turns", key: "provider_turn_id", id: "$.id" },
  "runtime-request.updated": { table: "runtime_requests", key: "runtime_request_id", id: "$.id" },
  "turn-item.updated": { table: "turn_items", key: "turn_item_id", id: "$.id" },
  "plan.updated": { table: "plans", key: "plan_id", id: "$.id" },
  "checkpoint-scope.created": { table: "checkpoint_scopes", key: "scope_id", id: "$.id" },
  "checkpoint.captured": { table: "checkpoints", key: "checkpoint_id", id: "$.id" },
  "checkpoint.rollback-requested": null,
  "context-handoff.updated": { table: "context_handoffs", key: "context_handoff_id", id: "$.id" },
};
/** Context transfers belong to the thread they were sent to. */
const TRANSFER_EVENTS = ["context-transfer.created", "context-transfer.updated"];
const KEPT_EVENTS = [
  "message.updated",
  "provider-session.attached",
  "provider-session.updated",
  "provider-session.detached",
];
export const MOVED_EVENT_TYPES = [...Object.keys(MOVED_EVENTS), ...TRANSFER_EVENTS];
const MOVED_TABLES = [
  ...new Set(Object.values(MOVED_EVENTS).flatMap((target) => (target ? [target.table] : []))),
];

const ACTIVE_RUN = ["preparing", "queued", "starting", "running", "waiting"];

interface EventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly aggregate_kind: string;
  readonly stream_id: string;
  readonly stream_version: number;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly command_id: string | null;
  readonly causation_event_id: string | null;
  readonly correlation_id: string | null;
  readonly actor_kind: string;
  readonly payload_json: string;
  readonly metadata_json: string;
  readonly application_event_version: number;
}

export interface HistoryBundle {
  readonly format: 1;
  readonly threadId: string;
  readonly events: ReadonlyArray<EventRow>;
  readonly positions: ReadonlyArray<{ readonly turn_item_id: string; readonly ordinal: number }>;
}

export interface OffloadedRecord {
  readonly threadId: ThreadId;
  readonly blobName: string;
  readonly sha256: string;
  readonly eventCount: number;
  readonly lastSequence: number;
  readonly localBytes: number;
  readonly blobBytes: number;
  readonly offloadedAt: string;
  readonly expiredAt: string | null;
}

export const encodeBundle = (bundle: HistoryBundle) => NodeZlib.gzipSync(JSON.stringify(bundle));
export const decodeBundle = (bytes: Uint8Array) =>
  JSON.parse(NodeZlib.gunzipSync(bytes).toString("utf8")) as HistoryBundle;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_history (
      thread_id TEXT PRIMARY KEY,
      blob_name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      local_bytes INTEGER NOT NULL,
      blob_bytes INTEGER NOT NULL,
      offloaded_at TEXT NOT NULL,
      expired_at TEXT,
      -- The settle (or archive) the history left under. A read brings it back
      -- without unsettling, so it moves again only after the next settle.
      settled_mark TEXT NOT NULL,
      restored_at TEXT
    )
  `;

  const toRecord = (row: Record<string, unknown>): OffloadedRecord => ({
    threadId: ThreadId.make(String(row.thread_id)),
    blobName: String(row.blob_name),
    sha256: String(row.sha256),
    eventCount: Number(row.event_count),
    lastSequence: Number(row.last_sequence),
    localBytes: Number(row.local_bytes),
    blobBytes: Number(row.blob_bytes),
    offloadedAt: String(row.offloaded_at),
    expiredAt: row.expired_at === null ? null : String(row.expired_at),
  });

  /** What identifies one settle or archive of a thread. */
  const settledMark = sql`
    COALESCE(json_extract(threads.payload_json, '$.settledAt'), '') || '|' ||
    COALESCE(threads.archived_at, '')
  `;

  const records = sql<Record<string, unknown>>`
    SELECT * FROM fork_thread_history WHERE restored_at IS NULL
  `.pipe(Effect.map((rows) => rows.map(toRecord)));

  const record = (threadId: ThreadId) =>
    sql<Record<string, unknown>>`
      SELECT * FROM fork_thread_history WHERE thread_id = ${threadId} AND restored_at IS NULL
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))));

  const movedEventsWhere = (threadId: ThreadId) => sql`
    stream_id = ${threadId}
    AND aggregate_kind = 'thread'
    AND application_event_version = 2
    AND event_type IN ${sql.in(MOVED_EVENT_TYPES)}
  `;

  /** Settled or archived threads with history still on this disk. */
  const candidates = sql<{ readonly thread_id: string }>`
    SELECT threads.thread_id
    FROM orchestration_v2_projection_threads AS threads
    WHERE threads.deleted_at IS NULL
      AND (json_extract(threads.payload_json, '$.settledOverride') = 'settled'
        OR threads.archived_at IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM fork_thread_history AS history
        WHERE history.thread_id = threads.thread_id
          AND (history.restored_at IS NULL OR history.settled_mark = ${settledMark})
      )
      AND EXISTS (
        SELECT 1 FROM orchestration_events AS events
        WHERE events.stream_id = threads.thread_id
          AND events.aggregate_kind = 'thread'
          AND events.event_type IN ${sql.in(MOVED_EVENT_TYPES)}
      )
    ORDER BY threads.updated_at ASC
  `.pipe(Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))));

  /**
   * Why this thread's history must stay local now, or null when it may move.
   * Runs inside the offload transaction too, so nothing can start between the
   * check and the delete.
   */
  const refusal = Effect.fn("ThreadHistoryStore.refusal")(function* (threadId: ThreadId) {
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) return "deleted";
    if (shell.settledOverride !== "settled" && shell.archivedAt === null) return "not settled";
    if (shell.activeRunId !== null) return "a turn is running";
    if (shell.pendingRuntimeRequest !== null) return "a request is waiting for an answer";
    if ((shell.pendingBackgroundTasks ?? []).length > 0) return "background work is pending";
    if (threadHasQueuedTurnStart(shell, yield* Clock.currentTimeMillis))
      return "a message is waiting to start";
    if (shell.limitRecovery?.autoResume === true) return "a usage-limit resume is scheduled";
    const [blocking] = yield* sql<{ readonly reason: string }>`
      SELECT 'a turn is running or queued' AS reason FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status IN ${sql.in(ACTIVE_RUN)}
      UNION ALL
      SELECT 'a request is waiting for an answer' FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id = ${threadId} AND status = 'pending'
      UNION ALL
      SELECT 'a secret request is waiting' FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND type = 'secret_request' AND status = 'waiting'
      UNION ALL
      SELECT 'effects are pending' FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
      UNION ALL
      SELECT 'it has an event type this fork does not know: ' || event_type
        FROM orchestration_events
        WHERE stream_id = ${threadId} AND aggregate_kind = 'thread'
          AND event_type NOT LIKE 'thread.%'
          AND event_type NOT IN ${sql.in([...MOVED_EVENT_TYPES, ...KEPT_EVENTS])}
      LIMIT 1
    `;
    if (blocking !== undefined) return blocking.reason;
    // A fork reads its source's rows live, so a source moves only once every
    // thread forked from it, at any depth, is settled or archived too.
    const [liveFork] = yield* sql<{ readonly thread_id: string }>`
      WITH RECURSIVE forks(thread_id) AS (
        SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE json_extract(payload_json, '$.forkedFrom.threadId') = ${threadId}
        UNION
        SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
          JOIN forks ON json_extract(child.payload_json, '$.forkedFrom.threadId') = forks.thread_id
      )
      SELECT threads.thread_id FROM forks
      JOIN orchestration_v2_projection_threads AS threads USING (thread_id)
      WHERE threads.deleted_at IS NULL
        AND json_extract(threads.payload_json, '$.settledOverride') IS NOT 'settled'
        AND threads.archived_at IS NULL
      LIMIT 1
    `;
    if (liveFork !== undefined) return "a thread forked from it is still open";
    // Ids are not always unique per thread (Orchestrator reuses message ids), and a
    // restore must never overwrite another thread's row.
    for (const [eventType, target] of Object.entries(MOVED_EVENTS)) {
      if (target === null) continue;
      const [shared] = yield* sql<{ readonly id: string }>`
        SELECT DISTINCT json_extract(events.payload_json, ${target.id}) AS id
        FROM orchestration_events AS events
        WHERE events.stream_id = ${threadId} AND events.aggregate_kind = 'thread'
          AND events.event_type = ${eventType}
          AND EXISTS (
            SELECT 1 FROM ${sql(`orchestration_v2_projection_${target.table}`)} AS rows
            WHERE rows.${sql(target.key)} = json_extract(events.payload_json, ${target.id})
              AND rows.thread_id IS NOT ${threadId}
          )
        LIMIT 1
      `;
      if (shared !== undefined)
        return `its ${target.table} id ${shared.id} belongs to another thread`;
    }
    return null;
  });

  /** The moved part of a thread, as it is now. */
  const collect = Effect.fn("ThreadHistoryStore.collect")(function* (threadId: ThreadId) {
    const events = yield* sql<EventRow>`
      SELECT * FROM orchestration_events WHERE ${movedEventsWhere(threadId)} ORDER BY sequence
    `;
    const positions = yield* sql<{ readonly turn_item_id: string; readonly ordinal: number }>`
      SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions
      WHERE thread_id = ${threadId} ORDER BY ordinal
    `;
    const localBytes = events.reduce(
      (sum, row) => sum + row.payload_json.length + row.metadata_json.length,
      0,
    );
    const bundle: HistoryBundle = { format: 1, threadId, events, positions };
    return { bundle, localBytes, lastSequence: events.at(-1)?.sequence ?? 0 };
  });

  const deleteMovedRows = (threadId: ThreadId) =>
    Effect.gen(function* () {
      for (const table of MOVED_TABLES) {
        yield* sql`DELETE FROM ${sql(`orchestration_v2_projection_${table}`)} WHERE thread_id = ${threadId}`;
      }
      yield* sql`DELETE FROM orchestration_v2_projection_context_transfers WHERE target_thread_id = ${threadId}`;
      yield* sql`DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId}`;
    });

  /**
   * Drops the moved part locally, once the uploaded copy is verified. Returns
   * false (and changes nothing) when the thread changed since `collect`.
   */
  const removeLocal = Effect.fn("ThreadHistoryStore.removeLocal")(function* (input: {
    readonly threadId: ThreadId;
    readonly blobName: string;
    readonly sha256: string;
    readonly eventCount: number;
    readonly lastSequence: number;
    readonly localBytes: number;
    readonly blobBytes: number;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* refusal(input.threadId)) !== null) return false;
        const [now] = yield* sql<{ readonly count: number; readonly last: number | null }>`
          SELECT count(*) AS count, max(sequence) AS last
          FROM orchestration_events WHERE ${movedEventsWhere(input.threadId)}
        `;
        if (now?.count !== input.eventCount || (now.last ?? 0) !== input.lastSequence) return false;
        yield* sql`DELETE FROM orchestration_events WHERE ${movedEventsWhere(input.threadId)}`;
        yield* deleteMovedRows(input.threadId);
        yield* sql`
          INSERT OR REPLACE INTO fork_thread_history (
            thread_id, blob_name, sha256, event_count, last_sequence, local_bytes, blob_bytes,
            offloaded_at, expired_at, settled_mark, restored_at
          )
          SELECT
            ${input.threadId}, ${input.blobName}, ${input.sha256}, ${input.eventCount},
            ${input.lastSequence}, ${input.localBytes}, ${input.blobBytes},
            ${DateTime.formatIso(yield* DateTime.now)}, NULL, ${settledMark}, NULL
          FROM orchestration_v2_projection_threads AS threads
          WHERE threads.thread_id = ${input.threadId}
        `;
        return true;
      }),
    );
  });

  /** Puts a verified bundle back and rebuilds its projection rows. */
  const restoreLocal = Effect.fn("ThreadHistoryStore.restoreLocal")(function* (
    bundle: HistoryBundle,
  ) {
    const threadId = ThreadId.make(bundle.threadId);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [threadRow] = yield* sql<Record<string, unknown>>`
          SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        `;
        const [before] = yield* sql<{ readonly last: number | null }>`
          SELECT max(sequence) AS last FROM orchestration_events
        `;
        // A partial restore could have left rows; the replay recreates them all.
        yield* deleteMovedRows(threadId);
        for (const row of bundle.events) {
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json, application_event_version
            ) VALUES (
              ${row.event_id}, ${row.aggregate_kind}, ${row.stream_id},
              (SELECT COALESCE(MAX(stream_version) + 1, 0) FROM orchestration_events
                WHERE aggregate_kind = ${row.aggregate_kind} AND stream_id = ${row.stream_id}),
              ${row.event_type}, ${row.occurred_at}, ${row.command_id},
              ${row.causation_event_id}, ${row.correlation_id}, ${row.actor_kind},
              ${row.payload_json}, ${row.metadata_json}, ${row.application_event_version}
            )
          `;
        }
        for (const position of bundle.positions) {
          yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES (${threadId}, ${position.turn_item_id}, ${position.ordinal})
          `;
        }
        const restored = yield* eventStore
          .read({ threadId, afterSequence: before?.last ?? 0 })
          .pipe(Stream.runCollect);
        for (const stored of restored) yield* projections.apply(stored.event);
        if (threadRow !== undefined) {
          yield* sql`
            UPDATE orchestration_v2_projection_threads SET ${sql.update(threadRow, ["thread_id"])}
            WHERE thread_id = ${threadId}
          `;
        }
        const last = Array.from(restored).at(-1)?.sequence;
        if (last !== undefined) {
          yield* sql`
            UPDATE orchestration_v2_projection_metadata SET last_sequence = ${last}
            WHERE projection_name = 'thread-projections' AND last_sequence < ${last}
          `;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`UPDATE fork_thread_history SET restored_at = ${now} WHERE thread_id = ${threadId}`;
      }),
    );
  });

  const markExpired = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE fork_thread_history SET expired_at = ${now} WHERE thread_id = ${threadId}`;
    });

  /** Changes whenever an event commits or an effect finishes. */
  const changeMark = sql<{ readonly last: number | null; readonly pending: number }>`
    SELECT
      (SELECT max(sequence) FROM orchestration_events) AS last,
      (SELECT count(*) FROM orchestration_v2_effect_outbox WHERE status IN ('pending', 'running'))
        AS pending
  `.pipe(Effect.map((rows) => `${rows[0]?.last ?? 0}:${rows[0]?.pending ?? 0}`));

  /**
   * Gives freed pages back to the disk once install-runtime.sh enabled incremental vacuum. Each
   * step of `incremental_vacuum` frees one page and the client steps a statement once, so it runs
   * once per free page, 2,000 pages (8 MB) per transaction.
   */
  const freePages = sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`.pipe(
    Effect.map((rows) => Number(rows[0]?.freelist_count ?? 0)),
  );
  const releaseFreePages = Effect.gen(function* () {
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (Number(mode[0]?.auto_vacuum) !== 2) return;
    for (let free = yield* freePages, before = Infinity; free > 0 && free < before;) {
      const pages = Math.min(free, 2_000);
      yield* sql.withTransaction(
        Effect.forEach(Array.from({ length: pages }), () => sql`PRAGMA incremental_vacuum`, {
          discard: true,
        }),
      );
      before = free;
      free = yield* freePages;
    }
  });

  return {
    records,
    record,
    changeMark,
    releaseFreePages,
    candidates,
    refusal,
    collect,
    removeLocal,
    restoreLocal,
    markExpired,
  };
});

export type ThreadHistoryStore = Effect.Success<typeof make>;

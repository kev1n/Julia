/**
 * Fork (Owner): work a restart would cut off, from projections: the query of
 * `fork/scripts/live-work.sh` plus thread ids (liveWork.test.ts checks they agree). Background work
 * counts only while its provider session is live; a held queued message survives a restart.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export interface LiveWorkItem {
  readonly kind: string;
  readonly threadId: string;
  readonly title: string;
  readonly what: string;
}

export const liveWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<LiveWorkItem>`
    WITH live_provider_threads AS (
      SELECT pt.provider_thread_id, pt.thread_id, pt.payload_json
      FROM orchestration_v2_projection_provider_threads AS pt
      JOIN orchestration_v2_projection_provider_sessions AS session
        ON session.provider_session_id = pt.provider_session_id
      WHERE session.status NOT IN ('stopped', 'error')
    ),
    work(kind, thread_id, what) AS (
      SELECT 'run ' || status, thread_id, ''
      FROM orchestration_v2_projection_runs
      WHERE status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1)
      UNION ALL
      SELECT json_extract(task.value, '$.kind'), live.thread_id,
        coalesce(json_extract(task.value, '$.description'), json_extract(task.value, '$.taskId'))
      FROM live_provider_threads AS live,
        json_each(CASE WHEN json_valid(live.payload_json) THEN live.payload_json ELSE '{}' END,
          '$.pendingBackgroundTasks') AS task
      UNION ALL
      SELECT item.type, item.thread_id, coalesce(json_extract(item.payload_json, '$.title'), '')
      FROM orchestration_v2_projection_turn_items AS item
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
      JOIN live_provider_threads AS live
        ON live.provider_thread_id = coalesce(item.provider_thread_id, run.provider_thread_id)
      WHERE item.type IN ('command_execution', 'dynamic_tool', 'subagent')
        AND item.status IN ('pending', 'running', 'waiting')
        AND coalesce(run.status, '') <> 'rolled_back'
        AND NOT (item.type = 'subagent'
          AND json_extract(item.payload_json, '$.origin') = 'app_owned'
          AND json_extract(item.payload_json, '$.childThreadId') IS NOT NULL)
      UNION ALL
      SELECT 'wake', turn.thread_id, ''
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN live_provider_threads AS live ON live.provider_thread_id = turn.provider_thread_id
      WHERE turn.status = 'running' AND turn.run_attempt_id IS NULL
    )
    SELECT work.kind AS kind, work.thread_id AS threadId,
      coalesce(thread.title, work.thread_id) AS title,
      replace(replace(work.what, char(10), ' '), char(9), ' ') AS what
    FROM work
    LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = work.thread_id
  `;
});

/**
 * The T3 threads a provider session belongs to: an agent's shell knows only its
 * provider's id for itself (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`), which
 * T3 records as the provider thread's native id.
 */
export const threadsOfProviderSession = Effect.fn("liveWork.threadsOfProviderSession")(function* (
  nativeId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS threadId
      FROM orchestration_v2_projection_provider_threads
      WHERE thread_id IS NOT NULL
        AND CASE WHEN json_valid(payload_json)
          THEN json_extract(payload_json, '$.nativeThreadRef.nativeId') END = ${nativeId}
    `;
  return rows.map((row) => row.threadId);
});

#!/bin/bash
# Prints the work a T3 restart would cut off, one line per item:
#   <kind><TAB><thread title><TAB><what>
# No output means the Mac is idle. Planned restarts (deploy-when-idle.sh,
# pull-deploy.sh) wait until it prints nothing.
#
# Besides runs that are working or about to, this counts background work a
# thread left running after its turn ended: provider subagents, background
# shells and Monitors (Claude's roster), and a wake Claude started to report a
# finished task. A restart kills all of these, so they count until they end.
# A held queued message is not live: it starts only when someone sends to its
# thread or resumes the queue, and it survives a restart.
# Background work only counts while its provider session is live: a stopped
# session's leftover rows are not running anything (see fork/restartWake.ts).
#
# Usage: live-work.sh [statev2.sqlite]   (default ~/.t3/userdata/statev2.sqlite)
set -euo pipefail
db="${1:-$HOME/.t3/userdata/statev2.sqlite}"
sqlite3 -readonly -separator $'\t' "$db" <<'SQL'
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
    -- A held queued message waits for someone to send or resume; a restart keeps it.
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
    -- A delegate_task child runs as its own thread; its runs count above.
    AND NOT (item.type = 'subagent'
      AND json_extract(item.payload_json, '$.origin') = 'app_owned'
      AND json_extract(item.payload_json, '$.childThreadId') IS NOT NULL)
  UNION ALL
  -- A provider turn outside any run: Claude woke the agent with a task result.
  SELECT 'wake', turn.thread_id, ''
  FROM orchestration_v2_projection_provider_turns AS turn
  JOIN live_provider_threads AS live ON live.provider_thread_id = turn.provider_thread_id
  WHERE turn.status = 'running' AND turn.run_attempt_id IS NULL
)
SELECT work.kind, coalesce(thread.title, work.thread_id), replace(replace(work.what, char(10), ' '), char(9), ' ')
FROM work
LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = work.thread_id;
SQL

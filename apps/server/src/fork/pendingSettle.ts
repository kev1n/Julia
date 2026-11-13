/**
 * Fork: an agent that settles its own thread mid-turn gets the settle when
 * that turn completes (ThreadManagementService.settleAfterRun). The request is kept
 * on the thread as `settleAfterRunId`, and at startup this waits again for each one
 * a restart cut off, following the run into its restart continuation.
 */
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const pendingSettles = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly threadId: string;
    readonly projectId: string;
    readonly runId: string;
  }>`
    SELECT thread_id AS threadId, project_id AS projectId,
      json_extract(payload_json, '$.settleAfterRunId') AS runId
    FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.settleAfterRunId') IS NOT NULL
      AND deleted_at IS NULL
  `;
  return rows.map((row) => ({
    threadId: ThreadId.make(row.threadId),
    projectId: ProjectId.make(row.projectId),
    runId: RunId.make(row.runId),
  }));
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const pending = yield* pendingSettles.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("fork.pending-settle.read-failed", { cause }).pipe(Effect.as([])),
      ),
    );
    yield* Effect.forEach(
      pending,
      (request) =>
        threads.settleAfterRun(request).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped),
      { discard: true },
    );
  }),
);

import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import { isRestartNoteSource } from "../orchestration-v2/RestartBackgroundNote.ts";

/**
 * Fork: a restart wakes a thread whose turn ended while its background work was still
 * running. Upstream stopped waking settled runs because stale records woke finished threads, so the
 * wake is decided only while the provider session is provably live: at `prepareForShutdown`, or at
 * startup after a crash. Delivery then needs no liveness check.
 */
export function restartWakeSourceRun(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerThreads" | "providerSessions" | "turnItems"
  >,
): OrchestrationV2Run | undefined {
  const { thread } = projection;
  if (thread.archivedAt !== null || thread.deletedAt !== null) return;
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" &&
      candidate.status !== "rolled_back" &&
      (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  // A running turn is upstream's continuation; a failed one is never continued.
  if (
    run === undefined ||
    (run.status !== "completed" && run.status !== "waiting" && run.status !== "interrupted") ||
    run.providerThreadId === null ||
    run.providerInstanceId !== thread.providerInstanceId
  )
    return;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (
    providerThread === undefined ||
    providerThread.ownerNodeId !== null ||
    providerThread.appThreadId !== thread.id
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  if (session === undefined || session.status === "stopped" || session.status === "error") return;
  const runIds = new Set(
    projection.runs.filter((r) => r.providerThreadId === providerThread.id).map((r) => r.id),
  );
  const liveItem = projection.turnItems.some(
    (item) =>
      (item.type === "subagent" ||
        item.type === "command_execution" ||
        item.type === "dynamic_tool") &&
      (item.status === "pending" || item.status === "running" || item.status === "waiting") &&
      // A delegate_task child is its own thread; it is continued and reports back itself.
      !(item.type === "subagent" && item.origin === "app_owned" && item.childThreadId !== null) &&
      (item.providerThreadId === providerThread.id ||
        (item.providerThreadId == null && item.runId !== null && runIds.has(item.runId))),
  );
  if (!liveItem && (providerThread.pendingBackgroundTasks?.length ?? 0) === 0) return;
  return run;
}

/**
 * A source run a restart wake may deliver to: its turn had ended and the restart
 * recorded background work it lost. Includes a run stopped with "stop only the main
 * agent", whose subagents were kept running on purpose.
 */
export function isRestartWakeSource(
  source: Pick<OrchestrationV2Run, "status" | "activeAttemptId" | "restartCancelledBackgroundWork">,
  providerTurns: Parameters<typeof isRestartNoteSource>[1],
): boolean {
  return (
    isRestartNoteSource(source, providerTurns) ||
    (source.status === "interrupted" && (source.restartCancelledBackgroundWork?.length ?? 0) > 0)
  );
}

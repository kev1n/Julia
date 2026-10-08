import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";

const FINISHED_VISIBILITY_MS = 2 * 60 * 1000;

/** The sidebar is a temporary roster, not the parent's durable Agents history. */
export function subagentThreadListExpiry(thread: EnvironmentThreadShell): number | null {
  if (
    (thread.source.nativeSubagentActivity === undefined && threadRuntimeIsActive(thread.runtime)) ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingBackgroundTasks.some((task) => task.kind !== "command")
  )
    return null;
  const status = thread.source.nativeSubagentActivity?.status ?? thread.source.status;
  if (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted" &&
    status !== "rolled_back"
  )
    return null;
  const completedAt = Date.parse(
    thread.source.nativeSubagentActivity?.completedAt ??
      thread.latestRun?.completedAt ??
      thread.updatedAt,
  );
  return Number.isFinite(completedAt) ? completedAt + FINISHED_VISIBILITY_MS : null;
}

/** Returns the next expiry so clients need one deadline timer, not a polling clock. */
export function visibleSubagentThreadList(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: number,
): { threads: ReadonlyArray<EnvironmentThreadShell>; nextExpiry: number | null } {
  let nextExpiry: number | null = null;
  const visible = threads.filter((thread) => {
    const expiry = subagentThreadListExpiry(thread);
    if (expiry === null) return true;
    if (expiry <= now) return false;
    nextExpiry = nextExpiry === null ? expiry : Math.min(nextExpiry, expiry);
    return true;
  });
  return { threads: visible, nextExpiry };
}

/** Shared lifecycle label; rows use glyphs, with this text for accessibility. */
export function subagentThreadListStatus(
  thread: EnvironmentThreadShell,
  resolve: MFunctionType = mFallback,
) {
  if (thread.hasPendingApprovals) return resolve(msg("Approval needed"));
  if (thread.hasPendingUserInput) return resolve(msg("Input needed"));
  const native = thread.source.nativeSubagentActivity;
  const status = native?.status ?? thread.source.status;
  if (
    native !== undefined
      ? status === "pending" || status === "running" || status === "waiting"
      : threadRuntimeIsActive(thread.runtime) || thread.runtime?.status === "idle"
  )
    return resolve(msg("In progress"));
  if (status === "failed") return resolve(msg("Failed"));
  if (status === "completed") return resolve(msg("Completed"));
  return resolve(msg("Stopped"));
}

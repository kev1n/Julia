import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/** Environment-local workspace identity. Chats sharing a worktree share tabs. */
export function workspaceChatKey(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "worktreePath">,
): string {
  return JSON.stringify([
    thread.environmentId,
    thread.projectId,
    thread.worktreePath?.replace(/[\\/]+$/, "") ?? null,
  ]);
}

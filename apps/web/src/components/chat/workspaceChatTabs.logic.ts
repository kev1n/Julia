import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

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

type WorkspaceChat = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "worktreePath"
  | "title"
  | "createdAt"
  | "latestUserMessageAt"
>;

export type WorkspaceChatSection = "pinned" | "active" | "working" | "snoozed" | "settled";
const sectionPriority: Record<WorkspaceChatSection, number> = {
  pinned: 0,
  active: 1,
  working: 2,
  snoozed: 3,
  settled: 4,
};

/** A session stays visible until all its chats leave the inbox. Closed tabs
 * still belong to it, just as they do in the tab strip's reopen menu. */
export function groupWorkspaceChatSessions<T extends WorkspaceChat>(
  threads: readonly T[],
  activeThread: ScopedThreadRef | null,
  sectionForThread: (thread: T) => WorkspaceChatSection,
) {
  const buckets = new Map<string, T[]>();
  for (const thread of threads) {
    const key = workspaceChatKey(thread);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(thread);
    else buckets.set(key, [thread]);
  }
  return [...buckets]
    .map(([key, members]) => {
      const chats = members.toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
      const first = chats[0]!;
      const latest = chats.reduce((left, right) =>
        (right.latestUserMessageAt ?? right.createdAt) >
        (left.latestUserMessageAt ?? left.createdAt)
          ? right
          : left,
      );
      const thread =
        chats.find(
          (chat) =>
            chat.environmentId === activeThread?.environmentId && chat.id === activeThread.threadId,
        ) ?? latest;
      const section = chats
        .map(sectionForThread)
        .reduce((left, right) => (sectionPriority[right] < sectionPriority[left] ? right : left));
      return {
        key,
        title: first.title,
        chats,
        thread,
        section,
        latestSentAt: latest.latestUserMessageAt ?? latest.createdAt,
      };
    })
    .toSorted(
      (left, right) =>
        right.latestSentAt.localeCompare(left.latestSentAt) || left.key.localeCompare(right.key),
    );
}

export type WorkspaceChatSession = ReturnType<
  typeof groupWorkspaceChatSessions<EnvironmentThreadShell>
>[number];

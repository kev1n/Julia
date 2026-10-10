import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** Tabs share a checkout and, when explicitly separated by a fork, a chat group. */
export function workspaceChatKey(
  thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "worktreePath" | "chatGroupId"
  >,
): string {
  return JSON.stringify([
    thread.environmentId,
    thread.projectId,
    thread.worktreePath?.replace(/[\\/]+$/, "") ?? null,
    ...(thread.chatGroupId === undefined ? [] : [thread.chatGroupId]),
  ]);
}

/** Every open chat in one tab strip (by `workspaceChatKey`), oldest first.
 * The strip is one thread to the user, so lifecycle actions move all of it. */
export function workspaceChatTabs<
  T extends WorkspaceChat &
    Pick<EnvironmentThreadShell, "archivedAt"> & {
      readonly lineage: Pick<EnvironmentThreadShell["lineage"], "relationshipToParent">;
    },
>(threads: readonly T[], key: string): T[] {
  return threads
    .filter(
      (chat) =>
        chat.archivedAt === null &&
        chat.lineage.relationshipToParent !== "subagent" &&
        workspaceChatKey(chat) === key,
    )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}

type WorkspaceChat = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "worktreePath"
  | "chatGroupId"
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
        latest,
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

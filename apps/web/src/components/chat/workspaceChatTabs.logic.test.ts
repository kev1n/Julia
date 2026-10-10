import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  groupWorkspaceChatSessions,
  workspaceChatKey,
  workspaceChatTabs,
  type WorkspaceChatSection,
} from "./workspaceChatTabs.logic";

it("shares tabs only within the same environment, project and checkout", () => {
  const root = {
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("repo"),
    worktreePath: null,
  };
  const worktree = { ...root, worktreePath: "/repo/worktrees/feature" };
  expect(workspaceChatKey({ ...worktree, worktreePath: worktree.worktreePath + "/" })).toBe(
    workspaceChatKey(worktree),
  );
  expect(workspaceChatKey(worktree)).not.toBe(workspaceChatKey(root));
  expect(workspaceChatKey({ ...worktree, environmentId: EnvironmentId.make("remote") })).not.toBe(
    workspaceChatKey(worktree),
  );
  expect(workspaceChatKey({ ...worktree, projectId: ProjectId.make("other-repo") })).not.toBe(
    workspaceChatKey(worktree),
  );
});

function chat(id: string, overrides: Partial<ReturnType<typeof chatDefaults>> = {}) {
  return { ...chatDefaults(id), ...overrides };
}

function chatDefaults(id: string) {
  return {
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("repo"),
    id: ThreadId.make(id),
    title: id,
    worktreePath: "/repo/feature" as string | null,
    createdAt: "2026-10-07T10:00:00Z",
    updatedAt: "2026-10-07T10:00:00Z",
    latestUserMessageAt: null as string | null,
    section: "active" as WorkspaceChatSection,
  };
}

it("keeps a stable session name and newest send when switching to an older tab", () => {
  const first = chat("Original task");
  const second = chat("Follow-up", {
    createdAt: "2026-10-07T11:00:00Z",
    latestUserMessageAt: "2026-10-07T12:00:00Z",
  });
  const [session] = groupWorkspaceChatSessions(
    [second, first],
    scopeThreadRef(first.environmentId, first.id),
    (thread) => thread.section,
  );
  expect(session).toMatchObject({
    title: "Original task",
    thread: first,
    // The sidebar sorts by this, so selecting a tab leaves the row in place.
    latest: second,
    chats: [first, second],
    latestSentAt: second.latestUserMessageAt,
  });
  const [inactive] = groupWorkspaceChatSessions([first, second], null, (thread) => thread.section);
  expect(inactive?.key).toBe(session?.key);
  expect(inactive?.thread).toBe(second);
});

it("moves the session on a send in any tab, not on an assistant update or tab selection", () => {
  const original = chat("original", { latestUserMessageAt: "2026-10-07T11:00:00Z" });
  const followup = chat("followup", { createdAt: "2026-10-07T10:30:00Z" });
  const other = chat("other", {
    worktreePath: "/repo/other",
    latestUserMessageAt: "2026-10-07T12:00:00Z",
  });
  const group = (threads: (typeof original)[]) =>
    groupWorkspaceChatSessions(
      threads,
      scopeThreadRef(original.environmentId, original.id),
      (thread) => thread.section,
    );
  expect(group([original, followup, other]).map((session) => session.title)).toEqual([
    "other",
    "original",
  ]);
  expect(
    group([{ ...original, updatedAt: "2026-10-07T14:00:00Z" }, followup, other]).map(
      (session) => session.title,
    ),
  ).toEqual(["other", "original"]);
  expect(
    group([original, { ...followup, latestUserMessageAt: "2026-10-07T13:00:00Z" }, other]).map(
      (session) => session.title,
    ),
  ).toEqual(["original", "other"]);
});

it("keeps all tabs together across lifecycle shelves and settles only when all are settled", () => {
  const settled = chat("settled", { section: "settled" });
  const working = chat("working", { section: "working" });
  const active = chat("active");
  const group = (threads: (typeof active)[]) =>
    groupWorkspaceChatSessions(threads, null, (thread) => thread.section);
  expect(group([settled, working, active])).toMatchObject([
    { section: "active", chats: expect.any(Array) },
  ]);
  expect(group([settled, working])[0]?.section).toBe("working");
  expect(group([settled, { ...working, section: "snoozed" }])[0]?.section).toBe("snoozed");
  expect(group([settled, { ...working, section: "settled" }])[0]?.section).toBe("settled");
  expect(group([settled, { ...working, section: "pinned" }, active])[0]?.section).toBe("pinned");
});

it("does not merge sessions from different environments, projects, or checkouts", () => {
  const first = chat("first");
  const threads = [
    first,
    chat("same checkout", { worktreePath: "/repo/feature/" }),
    chat("remote", { environmentId: EnvironmentId.make("remote") }),
    chat("other project", { projectId: ProjectId.make("other") }),
    chat("root", { worktreePath: null }),
  ];
  const sessions = groupWorkspaceChatSessions(threads, null, (thread) => thread.section);
  expect(sessions).toHaveLength(4);
  expect(sessions.find((session) => session.key === workspaceChatKey(first))?.chats).toHaveLength(
    2,
  );
});

it("keeps a new-thread fork separate on the same checkout, and its tab forks together", () => {
  const source = chat("source");
  const tab = chat("tab fork");
  const thread = { ...chat("thread fork"), chatGroupId: ThreadId.make("thread fork") };
  const nestedTab = { ...chat("nested tab"), chatGroupId: thread.chatGroupId };
  const nestedThread = { ...chat("nested thread"), chatGroupId: ThreadId.make("nested thread") };
  const groups = groupWorkspaceChatSessions(
    [source, tab, thread, nestedTab, nestedThread],
    null,
    (item) => item.section,
  );
  expect(groups).toHaveLength(3);
  expect(groups.find((group) => group.key === workspaceChatKey(source))?.chats).toEqual([
    source,
    tab,
  ]);
  expect(groups.find((group) => group.key === workspaceChatKey(thread))?.chats).toEqual([
    nestedTab,
    thread,
  ]);
  expect(workspaceChatKey(nestedThread)).not.toBe(workspaceChatKey(thread));
});

it("lists one strip's open chats, leaving out archived chats, subagents and other checkouts", () => {
  const tab = (id: string, overrides: Partial<ReturnType<typeof chatDefaults>> = {}) => ({
    ...chat(id, overrides),
    archivedAt: null as string | null,
    lineage: { relationshipToParent: null as "subagent" | "fork" | null },
  });
  const first = tab("first");
  const second = tab("second", { createdAt: "2026-10-07T11:00:00Z" });
  const threads = [
    second,
    first,
    { ...tab("archived"), archivedAt: "2026-10-07T12:00:00Z" },
    { ...tab("subagent"), lineage: { relationshipToParent: "subagent" as const } },
    tab("other checkout", { worktreePath: "/repo/other" }),
  ];
  expect(workspaceChatTabs(threads, workspaceChatKey(first))).toEqual([first, second]);
});

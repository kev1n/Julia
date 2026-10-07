import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ForkMoveReceiveInput,
  ForkMoveReceiveResult,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { StartThreadTurnInput } from "./operations/commands.ts";
import type { EnvironmentProject } from "./state/models.ts";
import {
  moveThread,
  threadMoveProject,
  threadMoveRefusal,
  type ThreadMoveSource,
} from "./threadMove.ts";

const sourceEnvironmentId = EnvironmentId.make("build-mac");
const targetEnvironmentId = EnvironmentId.make("macbook");
const now = Date.parse("2026-10-07T21:00:00Z");
const source: ThreadMoveSource = {
  id: ThreadId.make("original"),
  title: "Fix the bug",
  branch: "t3/fix",
  worktreePath: "/work/t3-fix",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex-old"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "full-access",
  latestRun: null,
  runtime: null,
};
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-target"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-07T21:00:00Z",
  models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

function fixture() {
  return {
    source,
    sourceEnvironmentId,
    sourceLabel: "build-mac",
    targetEnvironmentId,
    targetLabel: "MacBook",
    targetProject: { id: ProjectId.make("target-project"), workspaceRoot: "/Users/owner/src/repo" },
    targetProviders: [provider],
    driver: "codex",
    messages: [
      { role: "user" as const, text: "Please fix the bug" },
      { role: "assistant" as const, text: "Found the cause" },
    ],
    threadId: ThreadId.make("moved"),
    messageId: MessageId.make("handoff"),
    now,
    creationSource: "mobile" as const,
    receive: vi.fn<(input: ForkMoveReceiveInput) => Promise<ForkMoveReceiveResult>>(async () => ({
      branch: "t3/fix-2",
      commit: "a".repeat(40),
    })),
    start: vi.fn<(input: StartThreadTurnInput) => Promise<void>>(async () => {}),
    markSource: vi.fn<(title: string) => Promise<void>>(async () => {}),
  };
}

describe("moving a thread between Macs", () => {
  it("starts on the transferred commit with the conversation, model options and target account", async () => {
    const input = fixture();
    const result = await moveThread(input);
    expect(result).toEqual({
      environmentId: targetEnvironmentId,
      threadId: input.threadId,
      machine: "MacBook",
    });
    expect(input.receive).toHaveBeenCalledWith({
      sourceEnvironmentId,
      sourceWorktreePath: source.worktreePath,
      branch: source.branch,
      projectRoot: input.targetProject.workspaceRoot,
      commitMessage: "WIP: move to MacBook",
    });
    const launch = input.start.mock.calls[0]?.[0];
    expect(launch).toMatchObject({
      creationSource: "mobile",
      threadId: input.threadId,
      runtimeMode: source.runtimeMode,
      modelSelection: { ...source.modelSelection, instanceId: provider.instanceId },
      bootstrap: {
        createThread: { projectId: input.targetProject.id, branch: "t3/fix-2" },
        prepareWorktree: {
          baseBranch: "a".repeat(40),
          branch: "t3/fix-2",
          requireWorktree: true,
          startFromOrigin: false,
        },
      },
    });
    expect(launch?.message.text).toContain("Please fix the bug");
    expect(launch?.message.text).toContain("Found the cause");
    expect(input.markSource).toHaveBeenCalledWith("Moved to MacBook · Fix the bug");
    expect(input.receive.mock.invocationCallOrder[0]).toBeLessThan(
      input.start.mock.invocationCallOrder[0]!,
    );
    expect(input.start.mock.invocationCallOrder[0]).toBeLessThan(
      input.markSource.mock.invocationCallOrder[0]!,
    );
  });

  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "does not transfer a %s turn",
    async (status) => {
      const input = fixture();
      input.source = {
        ...source,
        latestRun: {
          runId: RunId.make("run"),
          status,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      };
      await expect(moveThread(input)).rejects.toThrow("Stop or wait");
      expect(input.receive).not.toHaveBeenCalled();
      expect(input.start).not.toHaveBeenCalled();
      expect(input.markSource).not.toHaveBeenCalled();
    },
  );

  it("refuses a shared checkout and a destination without an available account before committing files", async () => {
    const input = fixture();
    expect(threadMoveRefusal({ ...source, worktreePath: null })).toContain("own worktree");
    input.targetProviders = [];
    await expect(moveThread(input)).rejects.toThrow("No available codex account");
    expect(input.receive).not.toHaveBeenCalled();
  });

  it("refuses a destination whose account cannot serve the thread's model", async () => {
    const input = fixture();
    input.targetProviders = [
      {
        ...provider,
        models: [{ slug: "gpt-other", name: "Other", isCustom: false, capabilities: null }],
      },
    ];
    await expect(moveThread(input)).rejects.toThrow("No available codex account");
    expect(input.receive).not.toHaveBeenCalled();
  });

  it("does not start two destination threads when two machine controls trigger a move", async () => {
    const input = fixture();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launching = new Promise<void>((resolve) => {
      started = resolve;
    });
    input.start.mockImplementation(async () => {
      started();
      await pending;
    });
    const first = moveThread(input);
    await launching;
    await expect(moveThread(fixture())).rejects.toThrow("already moving");
    release();
    await first;
    expect(input.start).toHaveBeenCalledTimes(1);
    // The lock is released after completion, so moving back is not a one-way door.
    await expect(moveThread(fixture())).resolves.toMatchObject({ threadId: input.threadId });
  });

  it("leaves the source active when receiving the branch or launching the destination fails", async () => {
    for (const stage of ["receive", "start"] as const) {
      const input = fixture();
      input[stage].mockRejectedValueOnce(new Error("target offline"));
      await expect(moveThread(input)).rejects.toThrow("target offline");
      expect(input.markSource).not.toHaveBeenCalled();
      if (stage === "receive") expect(input.start).not.toHaveBeenCalled();
    }
  });
});

function project(environmentId: EnvironmentId, rootPath: string, subdir = ""): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(`${environmentId}:${subdir}`),
    title: "Repo",
    workspaceRoot: `${rootPath}${subdir}`,
    repositoryIdentity: {
      canonicalKey: "github.com/owner/t3code",
      rootPath,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/owner/t3code.git",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-07T21:00:00Z",
    updatedAt: "2026-10-07T21:00:00Z",
  };
}

describe("move destinations", () => {
  it("matches a checkout on another Mac even though the usernames and paths differ", () => {
    const original = project(sourceEnvironmentId, "/Users/user-b/repo");
    const target = project(targetEnvironmentId, "/Users/owner/src/repo");
    expect(threadMoveProject(original, [original, target], targetEnvironmentId)).toBe(target);
    expect(threadMoveProject(original, [original, target], sourceEnvironmentId)).toBeNull();
  });
  it("does not mistake another subproject in the same repository for the destination", () => {
    const original = project(sourceEnvironmentId, "/work/repo", "/apps/web");
    const otherSubproject = project(targetEnvironmentId, "/other/repo", "/apps/mobile");
    const matching = project(targetEnvironmentId, "/other/repo", "/apps/web");
    expect(threadMoveProject(original, [otherSubproject], targetEnvironmentId)).toBeNull();
    expect(threadMoveProject(original, [otherSubproject, matching], targetEnvironmentId)).toBe(
      matching,
    );
  });
});

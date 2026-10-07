import type {
  EnvironmentId,
  ForkMoveReceiveInput,
  ForkMoveReceiveResult,
  MessageId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { chooseAutoInstance } from "@t3tools/shared/accountChoice";

import type { StartThreadTurnInput } from "./operations/commands.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./state/models.ts";
import { deriveLogicalProjectKey } from "./state/projectGrouping.ts";
import { buildMoveMessage, type MoveContextMessage } from "./threadMoveContext.ts";

export {
  buildMoveMessage,
  selectMoveHistory,
  MOVE_CONTEXT_BUDGET_BYTES,
  type MoveContextMessage,
} from "./threadMoveContext.ts";

export type ThreadMoveSource = Pick<
  EnvironmentThreadShell,
  | "id"
  | "title"
  | "branch"
  | "worktreePath"
  | "modelSelection"
  | "runtimeMode"
  | "latestRun"
  | "runtime"
>;

/** Both clients explain the same constraint before any files or threads change. */
export function threadMoveRefusal(thread: ThreadMoveSource): string | null {
  const active = (status: string | undefined) =>
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting";
  if (active(thread.latestRun?.status) || active(thread.runtime?.status)) {
    return "Stop or wait for the current turn before moving the thread.";
  }
  if (!thread.worktreePath || !thread.branch) {
    return "Only threads in their own worktree can move. Start a worktree thread to keep the project checkout unchanged.";
  }
  return null;
}

/** Match repository and subdirectory, independently of how the sidebar is grouped. */
export function threadMoveProject(
  source: EnvironmentProject,
  projects: ReadonlyArray<EnvironmentProject>,
  environmentId: EnvironmentId,
): EnvironmentProject | null {
  if (source.environmentId === environmentId) return null;
  const key = deriveLogicalProjectKey(source, { groupingMode: "repository_path" });
  return (
    projects.find(
      (project) =>
        project.environmentId === environmentId &&
        deriveLogicalProjectKey(project, { groupingMode: "repository_path" }) === key,
    ) ?? null
  );
}

/** A move keeps the model; a destination must actually offer it on this driver. */
export function threadMoveProviders(
  providers: ReadonlyArray<ServerProvider>,
  driver: string,
  model: string,
) {
  return providers.filter(
    (provider) =>
      provider.driver === driver &&
      resolveSelectableModel(provider.driver, model, provider.models) !== null,
  );
}

/** Machine-to-machine move, shared by web/desktop and phone. Transports remain client-owned. */
async function performMoveThread(input: {
  readonly source: ThreadMoveSource;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceLabel: string;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string;
  readonly targetProject: Pick<EnvironmentProject, "id" | "workspaceRoot">;
  readonly targetProviders: ReadonlyArray<ServerProvider>;
  readonly driver: string;
  readonly messages: ReadonlyArray<MoveContextMessage>;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly now: number;
  readonly creationSource: "web" | "mobile";
  readonly receive: (input: ForkMoveReceiveInput) => Promise<ForkMoveReceiveResult>;
  readonly start: (input: StartThreadTurnInput) => Promise<void>;
  readonly markSource: (title: string) => Promise<void>;
}) {
  const refusal = threadMoveRefusal(input.source);
  if (refusal) throw new Error(refusal);
  if (input.sourceEnvironmentId === input.targetEnvironmentId) {
    throw new Error("This thread already runs on that machine.");
  }
  const account = chooseAutoInstance(
    threadMoveProviders(input.targetProviders, input.driver, input.source.modelSelection.model),
    input.driver,
    input.now,
  );
  if (!account) throw new Error(`No available ${input.driver} account on ${input.targetLabel}.`);
  const modelSelection = {
    ...input.source.modelSelection,
    instanceId: account.account.instanceId,
  };
  const received = await input.receive({
    sourceEnvironmentId: input.sourceEnvironmentId,
    sourceWorktreePath: input.source.worktreePath!,
    branch: input.source.branch!,
    projectRoot: input.targetProject.workspaceRoot,
    commitMessage: `WIP: move to ${input.targetLabel}`,
  });
  const text = buildMoveMessage({
    title: input.source.title,
    fromMachine: input.sourceLabel,
    toMachine: input.targetLabel,
    branch: received.branch,
    messages: input.messages,
  });
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(input.now));
  await input.start({
    creationSource: input.creationSource,
    threadId: input.threadId,
    message: { messageId: input.messageId, role: "user", text, attachments: [] },
    modelSelection,
    titleSeed: input.source.title,
    runtimeMode: input.source.runtimeMode,
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId: input.targetProject.id,
        title: input.source.title,
        modelSelection,
        runtimeMode: input.source.runtimeMode,
        interactionMode: "default",
        branch: received.branch,
        worktreePath: null,
        createdAt,
      },
      prepareWorktree: {
        projectCwd: input.targetProject.workspaceRoot,
        baseBranch: received.commit,
        branch: received.branch,
        requireWorktree: true,
        startFromOrigin: false,
      },
      runSetupScript: true,
    },
    createdAt,
  });
  await input.markSource(`Moved to ${input.targetLabel} · ${input.source.title}`);
  return {
    environmentId: input.targetEnvironmentId,
    threadId: input.threadId,
    machine: input.targetLabel,
  };
}

const movingThreads = new Set<string>();

/** One in-flight move per source, even when several client controls are open. */
export async function moveThread(input: Parameters<typeof performMoveThread>[0]) {
  const key = `${input.sourceEnvironmentId}/${input.source.id}`;
  if (movingThreads.has(key)) throw new Error("This thread is already moving to another machine.");
  movingThreads.add(key);
  try {
    return await performMoveThread(input);
  } finally {
    movingThreads.delete(key);
  }
}

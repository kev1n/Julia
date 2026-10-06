/**
 * Fork (Owner): "Move to <machine>" for a thread. One action hands the thread
 * to another environment that has the same project:
 *
 *   source machine                         target machine
 *   commit everything (incl. untracked) ─▶ origin/<branch> ─▶ new worktree on <branch>
 *   conversation (moveContext.ts) ───────────────────────▶ first message of a new thread
 *   source thread renamed "Moved to …" and settled; this client shows a banner linking over
 *
 * Built only from T3's own RPCs (source-control commit & push, thread launch
 * with a worktree from origin, metadata, settle), so the servers need nothing
 * new. A thread that is working, or that runs in the project checkout rather
 * than its own worktree branch, is refused: the move never pushes a shared
 * branch such as main.
 */
import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useCallback, useContext, useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { readProjects, readThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { vcsActionManager } from "../../state/vcs";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { chooseAutoInstance } from "../autoPlacement/useAutoAccount";
import { isAutoCandidate, useAutoPlacement } from "../autoPlacement/useAutoPlacement";
import { buildMoveMessage } from "./moveContext";
import { recordMovedThread } from "./movedThreads";

const MENU_PREFIX = "fork-move:";

export function isMoveMenuId(id: string): boolean {
  return id.startsWith(MENU_PREFIX);
}

const isWorking = (status: string | undefined) =>
  status === "preparing" || status === "starting" || status === "running";

class MoveRefused extends Error {}

export function useMoveThread(unstableThreadRef: ScopedThreadRef | null) {
  // Callers build the ref inline; key everything on its two ids.
  const environmentKey = unstableThreadRef?.environmentId ?? null;
  const threadKey = unstableThreadRef?.threadId ?? null;
  const threadRef = useMemo(
    () => (environmentKey && threadKey ? scopeThreadRef(environmentKey, threadKey) : null),
    [environmentKey, threadKey],
  );
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const weights = useClientSettings((settings) => settings.loadBalancingWeights);
  const { settleThread } = useThreadActions();

  const thread = threadRef ? readThreadShell(threadRef) : null;
  const sourceEnvironment = environments.find(
    (environment) => environment.environmentId === threadRef?.environmentId,
  );
  const driver = sourceEnvironment?.serverConfig?.providers.find(
    (provider) => provider.instanceId === thread?.modelSelection.instanceId,
  )?.driver;

  // Other connected machines that have this thread's project.
  const targets = useMemo(() => {
    if (!thread || !threadRef) return [];
    const projects = readProjects();
    const source = projects.find(
      (project) =>
        project.environmentId === threadRef.environmentId && project.id === thread.projectId,
    );
    if (!source) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(source, projectGroupingSettings);
    return environments.flatMap((environment) => {
      if (environment.environmentId === threadRef.environmentId) return [];
      if (environment.connection.phase !== "connected") return [];
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === environment.environmentId &&
          deriveLogicalProjectKeyFromSettings(candidate, projectGroupingSettings) === logicalKey,
      );
      return project ? [{ environment, project }] : [];
    });
  }, [environments, projectGroupingSettings, thread, threadRef]);

  // Auto's machine rule over the eligible targets (same rule as new threads).
  const autoCandidates = useMemo(
    () =>
      driver
        ? targets
            .filter(({ environment }) =>
              isAutoCandidate({
                environmentId: environment.environmentId,
                connected: true,
                serverConfig: environment.serverConfig,
                kind: resolveEnvironmentMachineKind(environment.serverConfig),
                weights,
                driver,
              }),
            )
            .map(({ environment }) => ({
              environmentId: environment.environmentId,
              label: environment.label,
            }))
        : [],
    [driver, targets, weights],
  );
  const auto = useAutoPlacement(autoCandidates, null);

  /** The machines a thread can move to, Auto's pick first. */
  const choices = useMemo(() => {
    if (!thread || targets.length === 0) return [];
    const sorted = [...targets].sort(
      (left, right) =>
        Number(right.environment.environmentId === auto.environmentId) -
        Number(left.environment.environmentId === auto.environmentId),
    );
    return sorted.map(({ environment }) => ({
      menuId: `${MENU_PREFIX}${environment.environmentId}`,
      label:
        environment.environmentId === auto.environmentId
          ? `${environment.label} (Auto)`
          : environment.label,
    }));
  }, [auto.environmentId, targets, thread]);

  const menuItems = useCallback(
    () =>
      choices.length === 0
        ? []
        : [
            {
              id: `${MENU_PREFIX}menu`,
              label: "Move to another machine",
              separatorBefore: true,
              children: choices.map(({ menuId, label }) => ({ id: menuId, label })),
            },
          ],
    [choices],
  );

  const move = useCallback(
    async (menuId: string) => {
      if (!threadRef || !thread || !sourceEnvironment) return;
      const target = targets.find(
        ({ environment }) => `${MENU_PREFIX}${environment.environmentId}` === menuId,
      );
      if (!target) return;
      const toast = (title: string, description?: string, type: "error" | "info" = "error") =>
        toastManager.add(
          stackedThreadToast({ type, title, ...(description ? { description } : {}) }),
        );
      try {
        const current = readThreadShell(threadRef);
        if (!current) throw new MoveRefused("The thread is no longer available.");
        if (isWorking(current.latestRun?.status)) {
          throw new MoveRefused("Stop or wait for the current turn before moving the thread.");
        }
        if (!current.worktreePath || !current.branch) {
          throw new MoveRefused(
            "Only threads in their own worktree can move: the move pushes the thread's branch, never the project checkout's branch.",
          );
        }
        const branch = current.branch;
        const toMachine = target.environment.label;
        toast(`Moving to ${toMachine}…`, `Committing and pushing ${branch}.`, "info");

        // 1. Everything in the worktree, untracked files included, onto the branch and origin.
        const pushed = await runAtomCommand(
          registry,
          vcsActionManager.runStackedAction({
            environmentId: threadRef.environmentId,
            cwd: current.worktreePath,
          }),
          {
            actionId: randomUUID(),
            action: "commit_push",
            commitMessage: `WIP: move to ${toMachine}`,
            threadId: current.id,
            projectId: current.projectId,
          },
          { label: "fork:move-thread:push", reportFailure: false, reportDefect: true },
        );
        if (pushed._tag === "Failure") throw squashAtomCommandFailure(pushed);

        // 2. The conversation, as the new thread's first message.
        const projection = Option.getOrNull(
          registry.get(environmentThreadDetails.stateAtom(threadRef)).data,
        );
        const text = buildMoveMessage({
          title: current.title,
          fromMachine: sourceEnvironment.label,
          toMachine,
          branch,
          messages: (projection?.messages ?? []).map(({ role, text }) => ({ role, text })),
        });

        // 3. The same model on the target, on the account Auto would use there.
        const targetProviders = target.environment.serverConfig?.providers ?? [];
        const account = driver ? chooseAutoInstance(targetProviders, driver, Date.now()) : null;
        const modelSelection: ModelSelection = {
          ...current.modelSelection,
          instanceId: account?.account.instanceId ?? current.modelSelection.instanceId,
        };
        const nextThreadId = newThreadId();
        const createdAt = new Date().toISOString();
        const started = await runAtomCommand(
          registry,
          threadEnvironment.startTurn,
          {
            environmentId: target.environment.environmentId,
            input: {
              threadId: nextThreadId,
              message: { messageId: newMessageId(), role: "user", text, attachments: [] },
              modelSelection,
              titleSeed: current.title,
              runtimeMode: current.runtimeMode,
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: target.project.id,
                  title: current.title,
                  modelSelection,
                  runtimeMode: current.runtimeMode,
                  interactionMode: "default",
                  branch,
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: target.project.workspaceRoot,
                  baseBranch: branch,
                  branch,
                  requireWorktree: true,
                  startFromOrigin: true,
                },
                runSetupScript: true,
              },
              createdAt,
            },
          },
          { label: "fork:move-thread:start", reportFailure: false, reportDefect: true },
        );
        if (started._tag === "Failure") throw squashAtomCommandFailure(started);

        // 4. Mark the source thread and remember where it went.
        const moved = scopeThreadRef(
          target.environment.environmentId as EnvironmentId,
          nextThreadId,
        );
        recordMovedThread(threadRef, {
          environmentId: moved.environmentId,
          threadId: moved.threadId,
          machine: toMachine,
        });
        await runAtomCommand(
          registry,
          threadEnvironment.updateMetadata,
          {
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              title: `Moved to ${toMachine} · ${current.title}`,
            },
          },
          { label: "fork:move-thread:rename", reportFailure: false, reportDefect: true },
        );
        await settleThread(threadRef);
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: moved.environmentId, threadId: moved.threadId },
        });
      } catch (error) {
        toast(
          error instanceof MoveRefused ? "Cannot move this thread" : "Move failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [driver, navigate, registry, settleThread, sourceEnvironment, targets, thread, threadRef],
  );

  return { choices, menuItems, move };
}

/**
 * Fork (Owner): "Move to <machine>". The branch travels as a git bundle over the fleet
 * (`fork.moveReceive`), the conversation becomes the new thread's first message, and the source is
 * renamed "Moved to …" and settled. A working thread, or one in the project checkout rather than
 * its own worktree, is refused, so a move never commits to a shared branch.
 */
import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import { useContext, useState } from "react";

import {
  useEnvironmentScope,
  readEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { newMessageId, newThreadId } from "../../lib/utils";
import { readThreadShell, useThreadShell, useProjects } from "../../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";

import { isAutoCandidate, useAutoPlacement } from "../autoPlacement/useAutoPlacement";
import { readMachineSummaries } from "../machines/useMachineCards";
import {
  moveThread as performThreadMove,
  threadMoveProject,
  threadMoveProviders,
  threadMoveRefusal,
} from "@t3tools/client-runtime/thread-move";
import { recordMovedThread } from "./movedThreads";
import { openMovedThread } from "./openMovedThread";

const MENU_PREFIX = "fork-move:";

/** On the target: take the thread's branch from the source machine (see the header). */
const moveReceive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "fork:move-thread:receive",
  tag: WS_METHODS.forkMoveReceive,
});

export function isMoveMenuId(id: string): boolean {
  return id.startsWith(MENU_PREFIX);
}

export function useMoveThread(unstableThreadRef: ScopedThreadRef | null) {
  // Callers build the ref inline; key everything on its two ids.
  const environmentKey = unstableThreadRef?.environmentId ?? null;
  const threadKey = unstableThreadRef?.threadId ?? null;
  const threadRef = environmentKey && threadKey ? scopeThreadRef(environmentKey, threadKey) : null;
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const weights = useClientSettings((settings) => settings.loadBalancingWeights);
  const { settleThread } = useThreadActions();

  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const [isMoving, setIsMoving] = useState(false);
  const canOperate = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const permittedTargets = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const disabledReason = !canOperate
    ? "This connection cannot move threads."
    : thread
      ? threadMoveRefusal(thread)
      : "The thread is no longer available.";
  const sourceEnvironment = environments.find(
    (environment) => environment.environmentId === threadRef?.environmentId,
  );
  const driver = threadRef
    ? providersByEnvironment
        .get(threadRef.environmentId)
        ?.find((provider) => provider.instanceId === thread?.modelSelection.instanceId)?.driver
    : undefined;

  // Other connected machines that have this thread's project.
  const targets = (() => {
    if (!thread || !threadRef) return [];
    const source = projects.find(
      (project) =>
        project.environmentId === threadRef.environmentId && project.id === thread.projectId,
    );
    if (!source) return [];
    return environments.flatMap((environment) => {
      if (environment.environmentId === threadRef.environmentId) return [];
      if (
        environment.connection.phase !== "connected" ||
        !permittedTargets.has(environment.environmentId)
      )
        return [];
      const project = threadMoveProject(source, projects, environment.environmentId);
      if (
        !threadMoveProviders(
          providersByEnvironment.get(environment.environmentId) ?? [],
          driver ?? "",
          thread.modelSelection.model,
        ).some((provider) => provider.enabled)
      )
        return [];
      return project ? [{ environment, project }] : [];
    });
  })();

  // Auto's machine rule over the eligible targets (same rule as new threads).
  const autoCandidates = driver
    ? targets
        .filter(({ environment }) =>
          isAutoCandidate({
            environmentId: environment.environmentId,
            connected: true,
            serverConfig: environment.serverConfig,
            providers: providersByEnvironment.get(environment.environmentId),
            kind: resolveEnvironmentMachineKind(environment.serverConfig),
            weights,
            driver,
          }),
        )
        .map(({ environment }) => ({
          environmentId: environment.environmentId,
          label: environment.label,
        }))
    : [];
  const auto = useAutoPlacement(autoCandidates, null);

  /** The machines a thread can move to, Auto's pick first. */
  const choices = (() => {
    if (!thread || targets.length === 0) return [];
    const sorted = [...targets].sort(
      (left, right) =>
        Number(right.environment.environmentId === auto.environmentId) -
        Number(left.environment.environmentId === auto.environmentId),
    );
    return sorted.map(({ environment }) => ({
      environmentId: environment.environmentId,
      machine: resolveEnvironmentMachineKind(environment.serverConfig),
      menuId: `${MENU_PREFIX}${environment.environmentId}`,
      label:
        environment.environmentId === auto.environmentId
          ? `${environment.label} (Auto)`
          : environment.label,
    }));
  })();

  // A native menu cannot change once shown, so each machine's CPU, memory and
  // disk are read as the menu opens rather than polled.
  const menuItems = async () => {
    if (choices.length === 0) return [];
    const usage = await readMachineSummaries(
      registry,
      choices.map((choice) => choice.environmentId),
    );
    return [
      {
        id: `${MENU_PREFIX}menu`,
        label: "Move to another machine",
        separatorBefore: true,
        children: choices.map(({ menuId, label, environmentId }) => ({
          id: menuId,
          label: `${label}  ·  ${usage.get(environmentId)}`,
        })),
      },
    ];
  };

  const move = async (menuId: string) => {
    if (!threadRef || !thread || !sourceEnvironment) return;
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    const target = targets.find(
      ({ environment }) => `${MENU_PREFIX}${environment.environmentId}` === menuId,
    );
    if (!target) return;
    const toast = (title: string, description?: string, type: "error" | "info" = "error") =>
      toastManager.add(
        stackedThreadToast({ type, title, ...(description ? { description } : {}) }),
      );
    // The move runs outside the hook so the React Compiler can still compile it.
    await runMove({
      registry,
      threadRef,
      sourceLabel: sourceEnvironment.label,
      target,
      driver,
      targetProviders: providersByEnvironment.get(target.environment.environmentId) ?? [],
      settleThread,
      navigate,
      toast,
      setIsMoving,
    }).catch((error: unknown) =>
      toast("Move failed", error instanceof Error ? error.message : String(error)),
    );
    setIsMoving(false);
  };

  return { choices, menuItems, move, disabledReason, isMoving };
}

interface MoveTarget {
  readonly environment: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly project: Parameters<typeof performThreadMove>[0]["targetProject"];
}

async function runMove(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRef: ScopedThreadRef;
  readonly sourceLabel: string;
  readonly target: MoveTarget;
  readonly driver: ServerProvider["driver"] | undefined;
  readonly targetProviders: ReadonlyArray<ServerProvider>;
  readonly settleThread: ReturnType<typeof useThreadActions>["settleThread"];
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly toast: (title: string, description?: string, type?: "error" | "info") => void;
  readonly setIsMoving: (moving: boolean) => void;
}) {
  const {
    registry,
    threadRef,
    sourceLabel,
    target,
    driver,
    targetProviders,
    settleThread,
    navigate,
    toast,
    setIsMoving,
  } = input;
  const current = readThreadShell(threadRef);
  if (!current) throw new Error("The thread is no longer available.");
  const reason = threadMoveRefusal(current);
  if (reason) throw new Error(reason);
  if (!driver) throw new Error("This thread's provider is no longer available.");
  setIsMoving(true);
  const toMachine = target.environment.label;
  toast(`Moving to ${toMachine}…`, `Sending ${current.branch} to ${toMachine}.`, "info");
  const projection = Option.getOrNull(
    registry.get(environmentThreadDetails.stateAtom(threadRef)).data,
  );
  const nextThreadId = newThreadId();
  const moved = scopeThreadRef(target.environment.environmentId, nextThreadId);
  await performThreadMove({
    source: current,
    sourceEnvironmentId: threadRef.environmentId,
    sourceLabel,
    targetEnvironmentId: target.environment.environmentId,
    targetLabel: toMachine,
    targetProject: target.project,
    targetProviders: targetProviders,
    driver,
    messages: (projection?.messages ?? []).map(({ role, text }) => ({ role, text })),
    threadId: nextThreadId,
    messageId: newMessageId(),
    now: Date.now(),
    creationSource: "web",
    receive: async (input) => {
      const result = await runAtomCommand(
        registry,
        moveReceive,
        {
          environmentId: target.environment.environmentId,
          input,
        },
        { label: "fork:move-thread:receive", reportFailure: false, reportDefect: true },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    start: async (input) => {
      const result = await runAtomCommand(
        registry,
        threadEnvironment.startTurn,
        {
          environmentId: target.environment.environmentId,
          input,
        },
        { label: "fork:move-thread:start", reportFailure: false, reportDefect: true },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      recordMovedThread(threadRef, { ...moved, machine: toMachine });
    },
    markSource: async (title) => {
      const result = await runAtomCommand(
        registry,
        threadEnvironment.updateMetadata,
        {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title },
        },
        { label: "fork:move-thread:rename", reportFailure: false, reportDefect: true },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const settled = await settleThread(threadRef);
      if (settled._tag === "Failure") throw squashAtomCommandFailure(settled);
    },
  });
  const opened = await openMovedThread({
    registry,
    shell: environmentThreadShells.threadShellAtom(moved),
    navigate: () =>
      navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: moved.environmentId, threadId: moved.threadId },
      }),
  });
  if (!opened) {
    toast(
      `Moved to ${toMachine}`,
      "The new thread has not reached this app yet. Open it from the banner or the sidebar once it appears.",
      "info",
    );
  }
}

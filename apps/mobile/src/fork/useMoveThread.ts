import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  moveThread,
  threadMoveProject,
  threadMoveProviders,
  threadMoveRefusal,
} from "@t3tools/client-runtime/thread-move";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  MessageId,
  ThreadId,
  WS_METHODS,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useContext, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  useEnvironmentScope,
  readEnvironmentScope,
  useEnvironmentsWithScope,
} from "../state/session";
import { uuidv4 } from "../lib/uuid";
import { useProjects, useThreadShell } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../state/threads";
import { openMovedThread } from "../../../web/src/fork/moveThread/openMovedThread";

const receive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "fork:move-thread:receive",
  tag: WS_METHODS.forkMoveReceive,
});

/** The phone uses the same bundle, handoff and account rule as desktop/web. */
export function useMoveThread(threadRef: ScopedThreadRef | null) {
  const registry = useContext(RegistryContext);
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const [isMoving, setIsMoving] = useState(false);
  const canOperate = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const permittedTargets = useEnvironmentsWithScope(
    [...presentations.keys()].map((environmentId) => ({ environmentId })),
    AuthOrchestrationOperateScope,
  );
  const source = threadRef ? presentations.get(threadRef.environmentId) : null;
  const sourceProject = projects.find(
    (project) =>
      project.environmentId === threadRef?.environmentId && project.id === thread?.projectId,
  );
  const driver = source?.serverConfig?.providers.find(
    (provider) => provider.instanceId === thread?.modelSelection.instanceId,
  )?.driver;
  const targets =
    sourceProject && driver
      ? [...presentations].flatMap(([environmentId, environment]) => {
          if (environment.connection.phase !== "connected" || !permittedTargets.has(environmentId))
            return [];
          const project = threadMoveProject(sourceProject, projects, environmentId);
          if (
            !project ||
            !threadMoveProviders(
              environment.serverConfig?.providers ?? [],
              driver,
              thread?.modelSelection.model ?? "",
            ).some((provider) => provider.enabled)
          )
            return [];
          return [{ environmentId, environment, project }];
        })
      : [];
  const disabledReason = !canOperate
    ? "This connection cannot move threads."
    : thread
      ? threadMoveRefusal(thread)
      : "This thread is no longer available.";

  async function move(environmentId: EnvironmentId, onMoved: (ref: ScopedThreadRef) => void) {
    if (!threadRef || !source || !driver || isMoving) return;
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope))
      throw new Error("This connection cannot move threads.");
    const current = registry.get(environmentThreadShells.threadShellAtom(threadRef));
    const target = targets.find((target) => target.environmentId === environmentId);
    if (!current || !target) throw new Error("This thread or machine is no longer available.");
    setIsMoving(true);
    try {
      const detail = Option.getOrNull(
        registry.get(environmentThreadDetails.stateAtom(threadRef)).data,
      );
      const moved = await moveThread({
        source: current,
        sourceEnvironmentId: threadRef.environmentId,
        sourceLabel: source.entry.target.label,
        targetEnvironmentId: environmentId,
        targetLabel: target.environment.entry.target.label,
        targetProject: target.project,
        targetProviders: target.environment.serverConfig?.providers ?? [],
        driver,
        messages: (detail?.messages ?? []).map(({ role, text }) => ({ role, text })),
        threadId: ThreadId.make(uuidv4()),
        messageId: MessageId.make(uuidv4()),
        now: Date.now(),
        creationSource: "mobile",
        receive: async (input) => {
          const result = await runAtomCommand(
            registry,
            receive,
            { environmentId, input },
            { reportFailure: false },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        start: async (input) => {
          const result = await runAtomCommand(
            registry,
            threadEnvironment.startTurn,
            { environmentId, input },
            { reportFailure: false },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
        markSource: async (title) => {
          const renamed = await runAtomCommand(
            registry,
            threadEnvironment.updateMetadata,
            {
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, title, creationSource: "mobile" },
            },
            { reportFailure: false },
          );
          if (renamed._tag === "Failure") throw squashAtomCommandFailure(renamed);
          const settled = await runAtomCommand(
            registry,
            threadEnvironment.settle,
            {
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, creationSource: "mobile" },
            },
            { reportFailure: false },
          );
          if (settled._tag === "Failure") throw squashAtomCommandFailure(settled);
        },
      });
      const ref = scopeThreadRef(moved.environmentId, moved.threadId);
      const opened = await openMovedThread({
        registry,
        shell: environmentThreadShells.threadShellAtom(ref),
        navigate: async () => onMoved(ref),
      });
      // The mobile thread route can hydrate a just-created thread; the bounded wait
      // normally lets its shell arrive before dismissing the settings sheet.
      if (!opened) onMoved(ref);
    } finally {
      setIsMoving(false);
    }
  }

  return {
    choices: targets.map(({ environmentId, environment }) => ({
      environmentId,
      label: environment.entry.target.label,
      machine: resolveEnvironmentMachineKind(environment.serverConfig),
    })),
    currentLabel: source?.entry.target.label ?? "This machine",
    disabledReason,
    isMoving,
    move,
  };
}

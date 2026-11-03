/**
 * Fork: the composer's Auto machine, replacing upstream's `useLoadBalancedEnvironment` with
 * `machineChoice.ts`, fed by `server.getHostResources` and running threads from the shell stream.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  resolveProjectProviderInstanceEnabled,
  type EnvironmentId,
  type ProjectId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useContext, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { autoWeight, chooseAutoMachine, type MachineDecision } from "./machineChoice";

// Mirrors `isRunning` in state/threads.ts: a thread counts while it prepares, starts, or runs.
const isRunningStatus = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

type ChosenMachine = Extract<MachineDecision, { kind: "chosen" }>;
const chosenByDraft = new Map<string, ChosenMachine>();

/** Whether a machine can take an Auto thread for the selected provider driver. */
export function isAutoCandidate(input: {
  readonly environmentId: string;
  readonly connected: boolean;
  readonly serverConfig: Pick<ServerConfig, "settings"> | null | undefined;
  /** Provider statuses arrive apart from the server config (see `useEnvironmentProviders`). */
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  /** The destination project, whose settings may override the machine's provider switch. */
  readonly projectId?: ProjectId | null;
  readonly kind: Parameters<typeof autoWeight>[2];
  readonly weights: Readonly<Record<string, number>>;
  readonly driver: string;
}): boolean {
  return (
    input.connected &&
    autoWeight(input.weights, input.environmentId, input.kind) > 0 &&
    (input.providers?.some(
      (provider) =>
        provider.driver === input.driver &&
        (input.serverConfig?.settings
          ? resolveProjectProviderInstanceEnabled(
              input.serverConfig.settings,
              input.projectId ?? null,
              provider.instanceId,
            )
          : provider.enabled) &&
        provider.installed &&
        provider.status !== "error" &&
        provider.auth.status !== "unauthenticated" &&
        provider.availability !== "unavailable",
    ) ??
      false)
  );
}

/** Given candidates only while a draft is on Auto, so idle clients do not poll hosts. */
export function useAutoPlacement(
  candidates: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
  draftId: string | null,
) {
  const registry = useContext(RegistryContext);
  const refresh = (ids: readonly EnvironmentId[]) => {
    for (const environmentId of ids) {
      registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
    }
  };
  const factsAtom = Atom.make((get) =>
    candidates.map(({ environmentId, label }) => {
      const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
      const running = get(environmentThreadShells.environmentThreadsAtom(environmentId)).filter(
        (thread) => isRunningStatus(thread.status),
      ).length;
      return {
        environmentId,
        label,
        resources: result._tag === "Success" ? result.value : null,
        pending: result._tag === "Initial" || result.waiting,
        running,
      };
    }),
  );
  const facts = useAtomValue(factsAtom);
  const pending = facts.some((entry) => entry.pending);
  const decision: MachineDecision = chooseAutoMachine(
    facts.flatMap((entry) =>
      entry.resources
        ? [
            {
              environmentId: entry.environmentId,
              label: entry.label,
              availableMemoryBytes: entry.resources.availableMemoryBytes,
              runningThreadCount: entry.running,
              freeDiskBytes: entry.resources.freeDiskBytes ?? null,
            },
          ]
        : [],
    ),
  );
  // The draft keeps its machine after Auto resolves and stops polling, and the
  // composer can remount, so the reason is remembered per draft.
  const [, rememberChosen] = useState<ChosenMachine | null>(null);
  if (draftId && !pending && decision.kind === "chosen") {
    const known = chosenByDraft.get(draftId);
    if (known?.environmentId !== decision.environmentId || known.reason !== decision.reason) {
      chosenByDraft.set(draftId, decision);
      rememberChosen(decision);
    }
  }
  // A draft resolved in an earlier session has no remembered reason; the live
  // ranking still explains it while it names the same machine.
  const lastChosen =
    (draftId ? chosenByDraft.get(draftId) : undefined) ??
    (!pending && decision.kind === "chosen" ? decision : null);
  return {
    refresh,
    pending,
    environmentId:
      !pending && decision.kind === "chosen" ? (decision.environmentId as EnvironmentId) : null,
    failed: !pending && decision.kind === "none",
    lastChosen,
  };
}

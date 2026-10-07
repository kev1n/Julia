/**
 * Fork (Owner): live host resources for every paired environment while the
 * Machines view is open and the window is visible. Idle clients never poll
 * hosts (the rule upstream's `useLoadBalancedEnvironment` states); the server
 * caches its snapshot for 5 seconds, which is the poll interval.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { environmentPresentations } from "../../state/presentation";
import { MACHINES_POLL_MS, machineCard, machineSummary, type MachineSource } from "./machineCards";

// The newest snapshot time seen per environment, so a machine that drops while
// the view is closed still shows when it was last seen.
const lastSeenByEnvironment = new Map<EnvironmentId, number>();

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document visibility so polling stops in hidden tabs
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function useMachineCards(selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null) {
  const registry = useContext(RegistryContext);
  const visible = usePageVisible();
  const machinesAtom = Atom.make((get) =>
    [...get(environmentPresentations.presentationsAtom)]
      .filter(([id]) => selectedEnvironmentIds === null || selectedEnvironmentIds.has(id))
      .map(([environmentId, presentation]) => {
        const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
        return {
          environmentId,
          label: presentation.entry.target.label,
          kind: resolveEnvironmentMachineKind(presentation.serverConfig),
          connected: presentation.connection.phase === "connected",
          resources: Option.getOrNull(AsyncResult.value(result)),
          failed: result._tag === "Failure",
        };
      }),
  );
  const machines = useAtomValue(machinesAtom);
  const [now, setNow] = useState(() => Date.now());
  const connectedIds = machines
    .filter((machine) => machine.connected)
    .map((machine) => machine.environmentId)
    .join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls each connected machine's host resources while the page is visible
  useEffect(() => {
    if (!visible) return;
    const ids = connectedIds ? (connectedIds.split(",") as EnvironmentId[]) : [];
    const timer = setInterval(() => {
      for (const environmentId of ids) {
        registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
      }
      setNow(Date.now());
    }, MACHINES_POLL_MS);
    return () => clearInterval(timer);
  }, [visible, connectedIds, registry]);
  return {
    now,
    cards: machines.map((machine) => ({ ...machine, card: rememberedCard(machine) })),
  };
}

function rememberedCard(machine: MachineSource & { readonly environmentId: EnvironmentId }) {
  const sampledAt = machine.resources?.sampledAt;
  if (
    sampledAt !== undefined &&
    sampledAt > (lastSeenByEnvironment.get(machine.environmentId) ?? -1)
  ) {
    lastSeenByEnvironment.set(machine.environmentId, sampledAt);
  }
  return machineCard(machine, lastSeenByEnvironment.get(machine.environmentId) ?? null);
}

/**
 * One-line summaries for a menu that cannot change once shown (the native
 * thread menu): each connected machine's snapshot as it is now, asked again
 * unless the client already holds one from the server's 5-second cache window.
 * A server that does not answer within the query's own timeout reads offline.
 */
export async function readMachineSummaries(
  registry: AtomRegistry.AtomRegistry,
  environmentIds: readonly EnvironmentId[],
): Promise<ReadonlyMap<EnvironmentId, string>> {
  const entries = await Promise.all(
    environmentIds.map(async (environmentId) => {
      const atom = serverEnvironment.hostResources({ environmentId, input: {} });
      const held = Option.getOrNull(AsyncResult.value(registry.get(atom)));
      if (!held || Date.now() - held.sampledAt >= MACHINES_POLL_MS) registry.refresh(atom);
      const exit = await Effect.runPromiseExit(
        AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
      );
      const resources = Exit.isSuccess(exit) ? exit.value : held;
      const card = rememberedCard({
        environmentId,
        connected: true,
        resources,
        failed: Exit.isFailure(exit),
      });
      return [environmentId, machineSummary(card, Date.now())] as const;
    }),
  );
  return new Map(entries);
}

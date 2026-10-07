/**
 * Fork (Owner): live host resources for every paired environment while the
 * Machines view is open and the window is visible. Idle clients never poll
 * hosts (the rule upstream's `useLoadBalancedEnvironment` states); the server
 * caches its snapshot for 5 seconds, which is the poll interval.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { environmentPresentations } from "../../state/presentation";
import { MACHINES_POLL_MS, machineCard } from "./machineCards";

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
  const machinesAtom = useMemo(
    () =>
      Atom.make((get) =>
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
      ),
    [selectedEnvironmentIds],
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
    cards: machines.map((machine) => {
      const sampledAt = machine.resources?.sampledAt;
      if (
        sampledAt !== undefined &&
        sampledAt > (lastSeenByEnvironment.get(machine.environmentId) ?? -1)
      ) {
        lastSeenByEnvironment.set(machine.environmentId, sampledAt);
      }
      return {
        ...machine,
        card: machineCard(machine, lastSeenByEnvironment.get(machine.environmentId) ?? null),
      };
    }),
  };
}

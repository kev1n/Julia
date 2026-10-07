/**
 * Fork (Owner): Usage > Machines on the phone. Cards come from the web fork's `machineCards.ts`;
 * this file reads the atoms and draws. Polls each server every 5 seconds only while the tab is on
 * screen and the app is in front, so the tab has no pull to refresh.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useMemo, useState } from "react";
import { AppState, View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { EnvironmentMachineSymbol } from "../components/EnvironmentMachineSymbol";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import {
  MACHINES_POLL_MS,
  machineCard,
  machineSummary,
  offlineText,
  type Meter,
} from "../../../web/src/fork/machines/machineCards";

const lastSeenByEnvironment = new Map<EnvironmentId, number>();

function useMachineCards(
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  active: boolean,
) {
  const registry = useContext(RegistryContext);
  const [foreground, setForeground] = useState(() => AppState.currentState === "active");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState so polling stops in the background
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
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
  const polling = active && foreground;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls each connected machine's host resources while the tab is shown
  useEffect(() => {
    if (!polling) return;
    const ids = connectedIds ? (connectedIds.split(",") as EnvironmentId[]) : [];
    const timer = setInterval(() => {
      for (const environmentId of ids) {
        registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
      }
      setNow(Date.now());
    }, MACHINES_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, connectedIds, registry]);
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

/**
 * One line per machine (`CPU 8% · Mem 9.6/16 GB · Disk 107/245 GB`) for the
 * new task's environment picker, polled while `active` (the picker on screen).
 */
export function useMachineSummaries(active: boolean): ReadonlyMap<EnvironmentId, string> {
  const { cards, now } = useMachineCards(null, active);
  return new Map(
    cards.map(({ environmentId, card }) => [environmentId, machineSummary(card, now)]),
  );
}

function MeterRow(props: { readonly label: string; readonly meter: Meter | null }) {
  const { label, meter } = props;
  return (
    <View className="gap-1">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm text-foreground-muted">{label}</Text>
        <Text className="text-sm font-t3-medium tabular-nums text-foreground">
          {meter ? `${meter.percent}%` : "-"}
        </Text>
      </View>
      <View className="h-2 overflow-hidden rounded-full bg-subtle">
        <View
          className="h-full rounded-full bg-primary"
          style={{ width: `${meter?.percent ?? 0}%` }}
        />
      </View>
      <Text className="text-xs tabular-nums text-foreground-tertiary">
        {meter?.detail ?? "not reported"}
      </Text>
    </View>
  );
}

/** Rendered only while the Machines tab is selected; `active` is the screen's focus. */
export function MachinesSection(props: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly active: boolean;
}) {
  const { cards, now } = useMachineCards(props.selectedEnvironmentIds, props.active);
  return (
    <View className="gap-4">
      {cards.map(({ environmentId, label, kind, card }) => (
        <View
          key={environmentId}
          accessibilityLabel={label}
          className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4"
        >
          <View className="flex-row items-center gap-3">
            <EnvironmentMachineSymbol kind={kind} size={28} tintColorClassName="accent-icon" />
            <View className="min-w-0 flex-1">
              <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
                {label}
              </Text>
              {card.kind === "offline" ? (
                <Text className="text-xs text-foreground-muted">
                  {offlineText(card.lastSeenAt, now)}
                </Text>
              ) : null}
            </View>
          </View>
          {card.kind === "online" ? (
            <View className="gap-3">
              <MeterRow label="CPU" meter={card.cpu} />
              <MeterRow label="Memory" meter={card.memory} />
              <MeterRow label="Disk" meter={card.disk} />
            </View>
          ) : card.kind === "loading" ? (
            <Text className="text-xs text-foreground-muted">Reading host resources...</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/**
 * Fork (Owner): one machine's CPU, memory and disk on one line, for machine menus. Render it only
 * inside the open menu: it polls that server for as long as it is mounted.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { machineSummary } from "./machineCards";
import { useMachineCards } from "./useMachineCards";

export function MachineUsageLine({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const selected = new Set([environmentId]);
  const { cards, now } = useMachineCards(selected);
  const card = cards[0]?.card;
  if (!card) return null;
  const summary = machineSummary(card, now);
  return (
    <span className="block truncate text-muted-foreground text-xs tabular-nums" data-machine-usage>
      {summary}
    </span>
  );
}

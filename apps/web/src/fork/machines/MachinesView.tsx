/**
 * Fork (Owner): Usage > Machines. One card per paired environment with its
 * picture, name and three bars (CPU, memory used of total, disk used of total).
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { EnvironmentMachineIcon } from "../../components/EnvironmentMachineIcon";
import { offlineText, type Meter } from "./machineCards";
import { useMachineCards } from "./useMachineCards";

function MeterRow({ label, meter }: { readonly label: string; readonly meter: Meter | null }) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)_3rem] items-center gap-x-3 gap-y-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${meter?.percent ?? 0}%` }}
        />
      </div>
      <span className="text-right text-sm font-semibold text-foreground tabular-nums">
        {meter ? `${meter.percent}%` : "-"}
      </span>
      <span className="col-start-2 col-end-4 text-2xs text-muted-foreground tabular-nums">
        {meter?.detail ?? "not reported"}
      </span>
    </div>
  );
}

export function MachinesView({
  selectedEnvironmentIds,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const { cards, now } = useMachineCards(selectedEnvironmentIds);
  return (
    <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
      {cards.map(({ environmentId, label, kind, card }) => (
        <section
          key={environmentId}
          aria-label={label}
          className="flex flex-col gap-3 rounded-lg border border-border/60 p-4"
        >
          <header className="flex items-center gap-3">
            <EnvironmentMachineIcon kind={kind} aria-hidden className="h-10 w-14" />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-medium text-foreground">{label}</h2>
              {card.kind === "offline" ? (
                <p className="text-xs text-muted-foreground">{offlineText(card.lastSeenAt, now)}</p>
              ) : null}
            </div>
          </header>
          {card.kind === "online" ? (
            <div className="flex flex-col gap-2">
              <MeterRow label="CPU" meter={card.cpu} />
              <MeterRow label="Memory" meter={card.memory} />
              <MeterRow label="Disk" meter={card.disk} />
            </div>
          ) : card.kind === "loading" ? (
            <p className="text-xs text-muted-foreground">Reading host resources...</p>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/**
 * Fork (Owner): two stacked bars beside the composer's model name, session on
 * top and week below, each filled to what is left with when it refills.
 */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { usageBars } from "./usageBarData";

export function UsageBars({
  limits,
  now,
}: {
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly now: number;
}) {
  const bars = usageBars(limits, now);
  if (bars.length === 0) return null;
  return (
    <span className="flex shrink-0 flex-col justify-center gap-0.5" aria-hidden="true">
      {bars.map((bar) => (
        <span key={bar.kind} className="flex items-center gap-1">
          <span className="h-1 w-6 overflow-hidden rounded-full bg-muted-foreground/20">
            <span
              className={cn(
                "block h-full rounded-full",
                bar.left < 20 ? "bg-destructive" : bar.left < 50 ? "bg-warning" : "bg-success",
              )}
              style={{ width: `${bar.left}%` }}
            />
          </span>
          <span className="w-6 text-3xs leading-none text-muted-foreground tabular-nums">
            {bar.resetsIn}
          </span>
        </span>
      ))}
    </span>
  );
}

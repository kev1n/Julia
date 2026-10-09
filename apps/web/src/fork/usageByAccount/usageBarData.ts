/**
 * Fork (Owner): the session and weekly windows of the composer's selected
 * account, as two stacked bars beside the model name (`UsageBars`).
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { windowRemainingPercent } from "@t3tools/shared/accountChoice";

export interface UsageBar {
  readonly kind: "session" | "weekly";
  /** Percent left, 0 to 100. */
  readonly left: number;
  /** `5.2h`, `42m`, `2.5d`; null when the window reports no future reset. */
  readonly resetsIn: string | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `42m`, `5.2h`, `14h`, `2.5d`: one or two digits, so the bars stay narrow. */
export function briefDuration(ms: number): string {
  const unit = (value: number, suffix: string) =>
    `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}${suffix}`;
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < 2 * DAY) return unit(ms / HOUR, "h");
  return unit(ms / DAY, "d");
}

/** The session window and the tightest weekly window, in that order; empty when neither is reported. */
export function usageBars(limits: ServerProviderUsageLimits | undefined, now: number): UsageBar[] {
  const tightest = (kind: UsageBar["kind"]) =>
    (limits?.windows ?? [])
      .filter((window) => window.kind === kind)
      .toSorted((a, b) => windowRemainingPercent(a, now) - windowRemainingPercent(b, now))[0];
  const bar = (kind: UsageBar["kind"], window: ServerProviderUsageWindow | undefined) => {
    if (!window) return null;
    const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    return {
      kind,
      left: windowRemainingPercent(window, now),
      resetsIn: Number.isFinite(resetsAt) && resetsAt > now ? briefDuration(resetsAt - now) : null,
    };
  };
  return [bar("session", tightest("session")), bar("weekly", tightest("weekly"))].filter(
    (entry) => entry !== null,
  );
}

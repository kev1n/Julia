/**
 * Fork (Owner): the subscription behind a provider instance and what it has
 * left, as one line for the model pickers (web composer, phone model sheet),
 * e.g. `owner · Max 20x · 88% session · resets 3:40 PM · 61% week`.
 */
import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";

import {
  accountStanding,
  LIMITED_BELOW_PERCENT,
  windowRemainingPercent,
} from "@t3tools/shared/accountChoice";
import { shortPlanLabel } from "../autoPlacement/planLabel";

type AccountSummaryProvider = Pick<ServerProvider, "displayName" | "auth" | "usageLimits">;

/** Null when the instance reports neither a plan, a login nor any usage window. */
export function accountLimitSummary(provider: AccountSummaryProvider, now: number): string | null {
  const login = provider.auth.email?.split("@")[0]?.trim();
  const name = provider.displayName?.trim() ?? "";
  const standing = accountStanding(provider.usageLimits, now);
  const parts = [
    // Instances are usually named after their login; saying it twice adds nothing.
    login && !name.includes(login) ? login : null,
    shortPlanLabel(provider.auth.label),
    ...(standing.limited
      ? [limitReachedLabel(provider.usageLimits, now)]
      : [
          standing.sessionLeft === null ? null : `${Math.round(standing.sessionLeft)}% session`,
          sessionResetLabel(provider.usageLimits, standing.sessionLeft, now),
          standing.weeklyLeft === null ? null : `${Math.round(standing.weeklyLeft)}% week`,
          standing.monthlyLeft === null ? null : `${Math.round(standing.monthlyLeft)}% month`,
        ]),
  ].filter((part) => part !== null && part !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** `no limit left · back Thu 3:40 PM`: when the last used-up window refills. */
function limitReachedLabel(limits: ServerProviderUsageLimits | undefined, now: number): string {
  const backAt = Math.max(
    ...(limits?.windows ?? [])
      .filter((window) => windowRemainingPercent(window, now) < LIMITED_BELOW_PERCENT)
      .map((window) => (window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt)))
      .filter(Number.isFinite),
  );
  if (!Number.isFinite(backAt)) return "no limit left";
  return `no limit left · back ${resetTime(backAt, now)}`;
}

/** `resets 3:40 PM`: when a partly used session refills; null once it already has. */
function sessionResetLabel(
  limits: ServerProviderUsageLimits | undefined,
  sessionLeft: number | null,
  now: number,
): string | null {
  if (sessionLeft === null || sessionLeft >= 100) return null;
  const resetsAt = limits?.windows.find((window) => window.kind === "session")?.resetsAt;
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  return Number.isFinite(at) && at > now ? `resets ${resetTime(at, now)}` : null;
}

/** `3:40 PM` today, `Thu 3:40 PM` on another day. */
function resetTime(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

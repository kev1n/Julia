/**
 * Fork (Owner): the subscription behind a provider instance and what it has
 * left, as one line for the model pickers (web composer, phone model sheet),
 * e.g. `owner · Max 20x · 88% session · 61% week`.
 */
import type { ServerProvider } from "@t3tools/contracts";

import { accountStanding, windowRemainingPercent } from "@t3tools/shared/accountChoice";
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
          standing.weeklyLeft === null ? null : `${Math.round(standing.weeklyLeft)}% week`,
        ]),
  ].filter((part) => part !== null && part !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** `no limit left · back Thu 3:40 PM`: when the last empty window refills. */
function limitReachedLabel(limits: ServerProvider["usageLimits"], now: number): string {
  const backAt = Math.max(
    ...(limits?.windows ?? [])
      .filter((window) => windowRemainingPercent(window, now) <= 0)
      .map((window) => (window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt)))
      .filter(Number.isFinite),
  );
  if (!Number.isFinite(backAt)) return "no limit left";
  const sameDay = new Date(backAt).toDateString() === new Date(now).toDateString();
  const time = new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(backAt);
  return `no limit left · back ${time}`;
}

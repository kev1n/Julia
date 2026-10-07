/**
 * Fork (Owner): the subscription behind a provider instance and what it has
 * left, as one line for the model pickers (web composer, phone model sheet),
 * e.g. `owner · Max 20x · 88% session · 61% week`.
 */
import type { ServerProvider } from "@t3tools/contracts";

import { accountStanding } from "@t3tools/shared/accountChoice";
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
    standing.sessionLeft === null ? null : `${Math.round(standing.sessionLeft)}% session`,
    standing.weeklyLeft === null ? null : `${Math.round(standing.weeklyLeft)}% week`,
  ].filter((part) => part !== null && part !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

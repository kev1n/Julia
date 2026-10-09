/**
 * Fork (Owner): the subscription behind a provider instance and what it has
 * left, as one line for the model pickers (web composer, phone model sheet),
 * e.g. `owner · Max 20x · 88% session · resets 3:40 PM · 61% week`.
 */
import type {
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

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
  const parts = [
    // Instances are usually named after their login; saying it twice adds nothing.
    login && !name.includes(login) ? login : null,
    shortPlanLabel(provider.auth.label),
    ...accountUsageParts(provider.usageLimits, now, { resets: "session" }),
  ].filter((part) => part !== null && part !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * One entry per window, e.g. `["72% session · resets 3:40 PM", "40% week"]`, or
 * `["no limit left · back Thu 3:40 PM"]` once a window is used up. `resets`
 * picks which windows say when they refill.
 */
export function accountUsageParts(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
  options: { readonly resets: "session" | "all" },
): string[] {
  const standing = accountStanding(limits, now);
  if (standing.limited) return [limitReachedLabel(limits, now)];
  const window = (kind: ServerProviderUsageWindow["kind"], left: number | null, label: string) => {
    if (left === null) return null;
    const reset =
      options.resets === "all" || kind === "session"
        ? windowResetLabel(limits, kind, left, now)
        : null;
    return reset ? `${Math.round(left)}% ${label} · ${reset}` : `${Math.round(left)}% ${label}`;
  };
  return [
    window("session", standing.sessionLeft, "session"),
    window("weekly", standing.weeklyLeft, "week"),
    window("monthly", standing.monthlyLeft, "month"),
  ].filter((part) => part !== null);
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

/** `resets 3:40 PM`: when a partly used window refills; null once it already has. */
function windowResetLabel(
  limits: ServerProviderUsageLimits | undefined,
  kind: ServerProviderUsageWindow["kind"],
  left: number,
  now: number,
): string | null {
  if (left >= 100) return null;
  // The tightest window of the kind, the one whose percent is shown.
  const resetsAt = (limits?.windows ?? [])
    .filter((window) => window.kind === kind)
    .toSorted(
      (a, b) => windowRemainingPercent(a, now) - windowRemainingPercent(b, now),
    )[0]?.resetsAt;
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

/**
 * Fork (Owner): the one rule for which account Auto uses (`chooseAutoAccount`). Skip accounts under
 * 5% in any window, then most left in the tightest window, then most session, then most weekly
 * left. Accounts without usage rank after; ties keep the caller's order.
 */
import {
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

/** Percent left in a window. A window whose reset time has passed is full again. */
export function windowRemainingPercent(window: ServerProviderUsageWindow, now: number): number {
  const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  if (Number.isFinite(resetsAt) && resetsAt <= now) return 100;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

/** A window with less than this percent left counts as used up: too little for a turn. */
export const LIMITED_BELOW_PERCENT = 5;

export interface AccountStanding {
  /** Percent left in the session window; null when the account reports none. */
  readonly sessionLeft: number | null;
  /** Percent left in the tightest weekly window; null when the account reports none. */
  readonly weeklyLeft: number | null;
  /** Percent left in the tightest monthly window; null when the account reports none. */
  readonly monthlyLeft: number | null;
  /** Percent left in the account's tightest window of any kind; null when it reports none. */
  readonly tightestLeft: number | null;
  /** Some reported window has under `LIMITED_BELOW_PERCENT` left. */
  readonly limited: boolean;
}

export function accountStanding(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): AccountStanding {
  const windows = limits?.windows ?? [];
  const session = windows.find((window) => window.kind === "session");
  const tightest = (kind?: ServerProviderUsageWindow["kind"]) => {
    const left = windows
      .filter((window) => kind === undefined || window.kind === kind)
      .map((window) => windowRemainingPercent(window, now));
    return left.length > 0 ? Math.min(...left) : null;
  };
  const tightestLeft = tightest();
  return {
    sessionLeft: session ? windowRemainingPercent(session, now) : null,
    weeklyLeft: tightest("weekly"),
    monthlyLeft: tightest("monthly"),
    tightestLeft,
    limited: tightestLeft !== null && tightestLeft < LIMITED_BELOW_PERCENT,
  };
}

/** Descending, with unknown (null) after every known value. */
function compareLeft(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

export interface AccountChoice<T> {
  readonly account: T;
  readonly standing: AccountStanding;
}

/**
 * The account Auto would use right now, or null when every account is
 * limited (or there are none).
 */
export function chooseAutoAccount<T>(
  accounts: ReadonlyArray<T>,
  limitsOf: (account: T) => ServerProviderUsageLimits | undefined,
  now: number,
): AccountChoice<T> | null {
  const ranked = accounts
    .map((account, index) => ({
      account,
      index,
      standing: accountStanding(limitsOf(account), now),
    }))
    .filter((entry) => !entry.standing.limited)
    .sort(
      (left, right) =>
        compareLeft(left.standing.tightestLeft, right.standing.tightestLeft) ||
        compareLeft(left.standing.sessionLeft, right.standing.sessionLeft) ||
        compareLeft(left.standing.weeklyLeft, right.standing.weeklyLeft) ||
        left.index - right.index,
    );
  const best = ranked[0];
  return best ? { account: best.account, standing: best.standing } : null;
}

/** One machine's usable instances of a driver, in the server's order. */
export function usableInstances(
  providers: ReadonlyArray<ServerProvider>,
  driver: string,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      provider.driver === driver &&
      provider.enabled &&
      provider.installed &&
      provider.auth.status !== "unauthenticated" &&
      isProviderAvailable(provider),
  );
}

/** The instance of `driver` Auto would use on one machine. */
export function chooseAutoInstance(
  providers: ReadonlyArray<ServerProvider>,
  driver: string,
  now: number,
): AccountChoice<ServerProvider> | null {
  return chooseAutoAccount(
    usableInstances(providers, driver),
    (provider) => provider.usageLimits,
    now,
  );
}

/**
 * The account whose session window resets soonest (still in the future), so
 * what it has left can be spent before the reset. Null when no account
 * reports a future session reset.
 */
export function soonestSessionReset<T>(
  accounts: ReadonlyArray<T>,
  limitsOf: (account: T) => ServerProviderUsageLimits | undefined,
  now: number,
): { readonly account: T; readonly resetsAt: number } | null {
  let soonest: { account: T; resetsAt: number } | null = null;
  for (const account of accounts) {
    const session = limitsOf(account)?.windows.find((window) => window.kind === "session");
    const resetsAt = session?.resetsAt === undefined ? Number.NaN : Date.parse(session.resetsAt);
    if (!Number.isFinite(resetsAt) || resetsAt <= now) continue;
    if (soonest === null || resetsAt < soonest.resetsAt) soonest = { account, resetsAt };
  }
  return soonest;
}

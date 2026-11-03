/**
 * Fork: Usage > Limits as one card per subscription account (merged across environments).
 * "Use now" marks the account Auto would pick (`chooseAutoAccount`); "Resets next" marks the
 * provider's account whose session window resets soonest.
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";

import { shortPlanLabel } from "../autoPlacement/planLabel";
import {
  chooseAutoAccount,
  soonestSessionReset,
  windowRemainingPercent,
} from "@t3tools/shared/accountChoice";

export interface AccountCardWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetsAt: number | null;
}

export interface AccountCard {
  readonly account: LimitAccount;
  /** The login: the email's local part when the provider reports one. */
  readonly login: string;
  /** Plan with tier as the provider reports it, e.g. `Max 20x`, `Plus`; null when unknown. */
  readonly plan: string | null;
  readonly windows: ReadonlyArray<AccountCardWindow>;
  readonly useNow: boolean;
  /** Epoch ms of the session reset when this account resets next for its provider. */
  readonly resetsNextAt: number | null;
}

const KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function accountLogin(account: LimitAccount): string {
  const local = account.email?.split("@")[0]?.trim();
  return local || account.displayName || account.key;
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function buildAccountCards(
  accounts: ReadonlyArray<LimitAccount>,
  now: number,
): ReadonlyArray<AccountCard> {
  const drivers = [...new Set(accounts.map((account) => account.driver))];
  return drivers.flatMap((driver) => {
    const members = accounts
      .filter((account) => account.driver === driver)
      .sort((left, right) => accountLogin(left).localeCompare(accountLogin(right)));
    const useNow = chooseAutoAccount(members, (account) => account.limits, now)?.account;
    const resetsNext = soonestSessionReset(members, (account) => account.limits, now);
    return members.map((account) => ({
      account,
      login: accountLogin(account),
      plan: shortPlanLabel(account.plan),
      windows: [...account.limits.windows]
        .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind])
        .map((window) => {
          const resetsAt = resetMillis(window);
          return {
            id: window.id,
            kind: window.kind,
            label: window.label,
            remainingPercent: Math.round(windowRemainingPercent(window, now)),
            resetsAt: resetsAt !== null && resetsAt > now ? resetsAt : null,
          };
        }),
      useNow: account === useNow,
      resetsNextAt: resetsNext?.account === account ? resetsNext.resetsAt : null,
    }));
  });
}

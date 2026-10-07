/**
 * Fork (Owner): Usage > Limits marks, per provider, the account Auto would use
 * now and the account whose session resets next, as the desktop's by-account
 * view does. The rule is the web fork's `buildAccountCards` (one owner), so the
 * phone and the desktop always mark the same account.
 */
import { formatDuration, type LimitAccount } from "@t3tools/shared/usageLimits";
import { View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { buildAccountCards } from "../../../web/src/fork/usageByAccount/accountCards";

export interface AccountFlag {
  readonly useNow: boolean;
  readonly resetsNextAt: number | null;
}

export function accountFlags(
  accounts: ReadonlyArray<LimitAccount>,
  now: number,
): ReadonlyMap<string, AccountFlag> {
  return new Map(
    buildAccountCards(accounts, now).map((card) => [
      card.account.key,
      { useNow: card.useNow, resetsNextAt: card.resetsNextAt },
    ]),
  );
}

export function AccountFlagBadges(props: { readonly flag?: AccountFlag; readonly now: number }) {
  const { flag, now } = props;
  if (!flag || (!flag.useNow && flag.resetsNextAt === null)) return null;
  return (
    <View className="flex-row items-center gap-1">
      {flag.useNow ? (
        <Text className="overflow-hidden rounded-full bg-primary px-2 py-0.5 text-xs font-t3-medium text-primary-foreground">
          Use now
        </Text>
      ) : null}
      {flag.resetsNextAt !== null ? (
        <Text className="overflow-hidden rounded-full bg-subtle-strong px-2 py-0.5 text-xs tabular-nums text-foreground-muted">
          Resets next · {formatDuration(flag.resetsNextAt - now)}
        </Text>
      ) : null}
    </View>
  );
}

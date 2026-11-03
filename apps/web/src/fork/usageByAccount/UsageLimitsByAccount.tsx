/**
 * Fork: Usage > Limits as one card per subscription account. Replaces
 * upstream's pooled-by-window view (`UsageLimitsPooled`); the data, notices,
 * and reset credits come from the same shared helpers.
 */
import {
  CHATGPT_USAGE_URL,
  collectExternalUsageLinks,
  collectLimitAccounts,
  collectLimitNotices,
  formatDuration,
} from "@t3tools/shared/usageLimits";
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { OpenAI } from "../../components/Icons";
import { providerClients } from "../../components/settings/providerDriverMeta";
import { Alert, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ResetCredits, barColor } from "../../components/usage/UsageLimits";
import { ensureLocalApi } from "../../localApi";
import { buildAccountCards, type AccountCard, type AccountCardWindow } from "./accountCards";

function formatClock(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function WindowRow({
  window,
  color,
  now,
}: {
  readonly window: AccountCardWindow;
  readonly color: string;
  readonly now: number;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)_3.5rem] items-center gap-x-3 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)_3.5rem_11rem]">
      <span className="truncate text-xs text-muted-foreground">{window.label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="h-full rounded-full"
          style={{ width: `${window.remainingPercent}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-right text-sm font-semibold text-foreground tabular-nums">
        {window.remainingPercent}%
      </span>
      <span className="col-span-3 text-2xs text-muted-foreground tabular-nums sm:col-span-1">
        {window.resetsAt === null
          ? "no reset reported"
          : `resets in ${formatDuration(window.resetsAt - now)} · ${formatClock(window.resetsAt)}`}
      </span>
    </div>
  );
}

function AccountCardView({ card, now }: { readonly card: AccountCard; readonly now: number }) {
  const { account } = card;
  const driverLabel = providerClients.get(account.driver)?.label ?? String(account.driver);
  const color = barColor(account.driver);
  const where = account.environments.map((environment) => environment.label).join(", ");
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border/60 p-4"
      aria-label={`${driverLabel} ${card.login}`}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ProviderInstanceIcon
          driverKind={account.driver}
          displayName={driverLabel}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        <h2 className="text-sm font-medium text-foreground">
          {driverLabel} {card.login}
          {card.plan ? <span className="text-muted-foreground"> · {card.plan}</span> : null}
        </h2>
        {card.useNow ? <Badge variant="success">Use now</Badge> : null}
        {card.resetsNextAt !== null ? (
          <Badge variant="info">Resets next · {formatDuration(card.resetsNextAt - now)}</Badge>
        ) : null}
        <span className="ms-auto truncate text-2xs text-muted-foreground">
          {where || account.sourceLabel || ""}
        </span>
      </header>
      <div className="flex flex-col gap-2">
        {card.windows.map((window) => (
          <WindowRow key={`${window.kind}:${window.id}`} window={window} color={color} now={now} />
        ))}
      </div>
      {account.redeem && account.limits.resetCredits ? (
        <ResetCredits
          environmentId={account.redeem.environmentId}
          input={account.redeem.input}
          credits={account.limits.resetCredits}
          now={now}
        />
      ) : null}
    </section>
  );
}

export function UsageLimitsByAccount({
  presentations,
  now,
  cursorPrompt,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const cards = buildAccountCards(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  return (
    <div className="flex flex-col gap-4">
      {cards.length === 0 && notices.length === 0 && !cursorPrompt && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {cards.map((card) => (
        <AccountCardView key={card.account.key} card={card} now={now} />
      ))}
      {cursorPrompt}
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              {link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Manage usage
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      {notices.length > 0 ? (
        <Alert variant="warning" controlAlignment="first-line">
          <AlertTriangleIcon />
          {notices.map((notice) => (
            <AlertTitle key={notice} className="break-words">
              {notice}
            </AlertTitle>
          ))}
        </Alert>
      ) : null}
    </div>
  );
}

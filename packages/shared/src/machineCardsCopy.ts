/**
 * Fork: the text of the Usage > Machines cards (apps/web/src/fork/machines/machineCards.ts).
 * It lives here because the phone draws the same cards and cannot bundle gt-react.
 */
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { formatDuration } from "./usageLimitsCopy.ts";

interface MachineSummaryCard {
  readonly kind: "online" | "offline" | "loading";
  readonly lastSeenAt?: number | null;
  readonly cpu?: { readonly short: string } | null;
  readonly memory?: { readonly short: string };
  readonly disk?: { readonly short: string } | null;
}

/** `Offline · last seen 12m ago`, from the server's own snapshot time. */
export function offlineText(
  lastSeenAt: number | null,
  now: number,
  resolve: MFunctionType = mFallback,
): string {
  if (lastSeenAt === null) return resolve(msg("Offline · not seen since the app opened"));
  const ago = now - lastSeenAt;
  return ago < 60_000
    ? resolve(msg("Offline · last seen just now"))
    : resolve(
        msg("Offline · last seen {duration} ago", { duration: formatDuration(ago, resolve) }),
      );
}

/**
 * One machine on one line, for the places a machine is picked (the composer's
 * machine menu, Move to another machine, the phone's environment picker):
 * `CPU 8% · Mem 9.6/16 GB · Disk 107/245 GB`. A reading the server does not
 * report is `-`, as on the Machines cards.
 */
export function machineSummary(
  card: MachineSummaryCard,
  now: number,
  resolve: MFunctionType = mFallback,
): string {
  if (card.kind === "offline") return offlineText(card.lastSeenAt ?? null, now, resolve);
  if (card.kind === "loading") return resolve(msg("Reading host resources..."));
  return resolve(
    msg("CPU {cpu} · Mem {memory} · Disk {disk}", {
      cpu: card.cpu?.short ?? "-",
      memory: card.memory?.short ?? "-",
      disk: card.disk?.short ?? "-",
    }),
  );
}

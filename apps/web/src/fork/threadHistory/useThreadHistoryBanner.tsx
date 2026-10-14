/**
 * Fork (Owner): opening a thread whose history is in Azure starts its restore; this says so, and
 * says plainly when it expired or Azure was unreachable. While restoring or failed, it takes the
 * composer's activity slot in place of "Syncing messages".
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ForkThreadHistoryStatus, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { CloudDownloadIcon, CloudOffIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "../../components/chat/ComposerBannerStack";
import { InlineButton } from "../../components/ui/button";
import { serverEnvironment } from "../../state/server";

const NO_THREAD = Atom.make(AsyncResult.initial<ForkThreadHistoryStatus, never>());

function settledOn(status: ForkThreadHistoryStatus) {
  return status.offloadedAt === undefined
    ? ""
    : ` (settled ${new Date(status.offloadedAt).toLocaleDateString()})`;
}

export function useThreadHistoryBanner(
  threadRef: ScopedThreadRef | null,
): ComposerBannerStackItem | null {
  const atom =
    threadRef === null
      ? NO_THREAD
      : serverEnvironment.threadHistory({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        });
  const status = Option.getOrNull(AsyncResult.value(useAtomValue(atom)));
  const retry = useAtomRefresh(atom);
  switch (status?.state) {
    case "restoring":
      return {
        id: "fork-thread-history",
        variant: "info",
        group: "environment",
        icon: <CloudDownloadIcon />,
        title: "Restoring this thread's history",
        description: "It was moved to Azure when the thread settled.",
      };
    case "expired":
      return {
        id: "fork-thread-history",
        variant: "warning",
        icon: <CloudOffIcon />,
        title: "History expired",
        description: `Kept 60 days after the thread settled${settledOn(status)}, then deleted from Azure.`,
      };
    case "unavailable":
      return {
        id: "fork-thread-history",
        variant: "error",
        group: "environment",
        icon: <CloudOffIcon />,
        title: "History unavailable",
        description: status.message ?? "Azure could not be reached.",
        actions: <InlineButton onClick={retry}>Retry</InlineButton>,
      };
    default:
      return null;
  }
}

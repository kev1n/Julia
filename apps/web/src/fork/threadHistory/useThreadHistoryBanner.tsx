/**
 * Fork (Owner): opening a thread whose history is in Azure starts its restore; this says so, and
 * says plainly when it expired or Azure was unreachable. While restoring or failed, it takes the
 * composer's activity slot in place of "Syncing messages".
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ForkThreadHistoryStatus, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { CloudDownloadIcon, CloudOffIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "../../components/chat/ComposerBannerStack";
import { InlineButton } from "../../components/ui/button";
import { serverEnvironment } from "../../state/server";

const NO_THREAD = Atom.make(AsyncResult.initial<ForkThreadHistoryStatus, never>());

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
  const gt = useGT();
  switch (status?.state) {
    case "restoring":
      return {
        id: "fork-thread-history",
        variant: "info",
        group: "environment",
        icon: <CloudDownloadIcon />,
        title: gt("Restoring this thread's history"),
        description: gt("It was moved to Azure when the thread settled."),
      };
    case "expired":
      return {
        id: "fork-thread-history",
        variant: "warning",
        icon: <CloudOffIcon />,
        title: gt("History expired"),
        description:
          status.offloadedAt === undefined
            ? gt("Kept 60 days after the thread settled, then deleted from Azure.")
            : gt(
                "Kept 60 days after the thread settled (settled {date}), then deleted from Azure.",
                {
                  date: new Date(status.offloadedAt).toLocaleDateString(),
                },
              ),
      };
    case "unavailable":
      return {
        id: "fork-thread-history",
        variant: "error",
        group: "environment",
        icon: <CloudOffIcon />,
        title: gt("History unavailable"),
        description: status.message ?? gt("Azure could not be reached."),
        actions: (
          <InlineButton onClick={retry}>
            <T>Retry</T>
          </InlineButton>
        ),
      };
    default:
      return null;
  }
}

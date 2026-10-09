import { T, Var } from "gt-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { parseUrl } from "@t3tools/shared/url";
import { Globe, History, RadioTower } from "lucide-react";

import type { BrowserHistoryEntry } from "~/browserHistoryStore";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { DiscoveryList } from "../ui/discovery-list";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewRecentUrlCard } from "./PreviewRecentUrlCard";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

export function PreviewEmptyState({
  threadRef,
  environmentId,
  configuredUrls,
  recentEntries,
  onRemoveRecent,
  onOpenUrl,
}: Props) {
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
  });
  const recents = recentEntries.filter((entry) => parseUrl(entry.url) !== null).slice(0, 8);

  return (
    <div className="scrollbar-gutter-both flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <Empty size="compact">
          <EmptyMedia variant="icon">
            <Globe />
          </EmptyMedia>
          <EmptyTitle>
            <T>New tab</T>
          </EmptyTitle>
          <EmptyDescription>
            <T>Enter a website address above to start browsing.</T>
          </EmptyDescription>
        </Empty>
        {recents.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <History className="size-4 shrink-0" />
              <h2 className="font-medium">
                <T>Recently used</T>
              </h2>
            </div>
            <DiscoveryList>
              {recents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  threadRef={threadRef}
                  entry={entry}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </DiscoveryList>
          </div>
        ) : null}
        {servers.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <RadioTower className="size-4 shrink-0" />
                <span>
                  <T>
                    Developer shortcuts (<Var>{servers.length}</Var>)
                  </T>
                </span>
              </span>
            </summary>
            <p className="my-3 text-xs text-muted-foreground">
              <T>Optional shortcuts to apps running on this environment.</T>
            </p>
            <DiscoveryList>
              {servers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  threadRef={threadRef}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </DiscoveryList>
          </details>
        ) : null}
      </div>
    </div>
  );
}

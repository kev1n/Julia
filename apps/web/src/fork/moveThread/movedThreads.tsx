/**
 * Fork (Owner): where a moved thread went. The source thread is renamed and
 * settled on its own server; this client also remembers the destination so
 * the source thread can show a banner that opens the new one.
 */
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeftIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import type { ComposerBannerStackItem } from "../../components/chat/ComposerBannerStack";
import { InlineButton } from "../../components/ui/button";

export interface MovedThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly machine: string;
}

const STORAGE_KEY = "t3code-fork:moved-threads:v1";
const listeners = new Set<() => void>();

function readAll(): Record<string, MovedThread> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, MovedThread>) : {};
  } catch {
    return {};
  }
}

const keyOf = (ref: ScopedThreadRef) => `${ref.environmentId}/${ref.threadId}`;

export function recordMovedThread(source: ScopedThreadRef, target: MovedThread): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [keyOf(source)]: target }));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** "Moved to <machine name> · Open" on a thread this client moved. */
export function useMovedThreadBanner(
  threadRef: ScopedThreadRef | null,
): ComposerBannerStackItem | null {
  const navigate = useNavigate();
  const snapshot = useSyncExternalStore(subscribe, () => localStorage.getItem(STORAGE_KEY));
  if (threadRef === null || snapshot === null) return null;
  const moved = readAll()[keyOf(threadRef)];
  if (!moved) return null;
  return {
    id: "fork-moved-thread",
    variant: "info",
    icon: <ArrowRightLeftIcon />,
    title: `Moved to ${moved.machine}`,
    description: "This thread continues on the other machine with its branch and conversation.",
    actions: (
      <InlineButton
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: moved.environmentId, threadId: moved.threadId },
          })
        }
      >
        Open
      </InlineButton>
    ),
  };
}

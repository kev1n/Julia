import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  visibleSubagentThreadList,
  subagentThreadListStatus,
} from "@t3tools/client-runtime/state/subagent-thread-list";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  PauseIcon,
  ShieldQuestionIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";

import { environmentThreadShells } from "../../state/threads";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/spinner";

/** Shell-only subscription: showing children must not hydrate every parent's history. */
export function useSidebarSubagents(ref: ScopedThreadRef) {
  const all = useAtomValue(environmentThreadShells.subagentThreadShellsAtom(ref));
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState(true);
  const roster = visibleSubagentThreadList(all, now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer that drops finished subagents from the roster when they expire
  useEffect(() => {
    if (roster.nextExpiry === null) return;
    const expiry = roster.nextExpiry;
    const timer = setTimeout(
      () => setNow(Math.max(expiry, Date.now())),
      Math.max(0, expiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [roster.nextExpiry]);
  return { all, threads: roster.threads, expanded, setExpanded };
}

export function SidebarSubagentDisclosure(props: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (props.count === 0) return null;
  return (
    <button
      type="button"
      aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.count} ${props.count === 1 ? "subagent" : "subagents"}`}
      aria-expanded={props.expanded}
      className="flex h-9 shrink-0 cursor-pointer items-center gap-1 px-1 text-2xs tabular-nums text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
    >
      {props.count}
      <ChevronRightIcon aria-hidden className={cn("size-3", props.expanded && "rotate-90")} />
    </button>
  );
}

export function SidebarSubagentRows(props: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  expanded: boolean;
  activeThreadKey: string | null;
  onNavigate: (event: MouseEvent, ref: ScopedThreadRef) => void;
}) {
  if (!props.expanded || props.threads.length === 0) return null;
  return (
    <ul aria-label="Subagents" className="mr-2 mb-1 ml-9 border-l border-sidebar-border pl-2">
      {props.threads.map((thread) => {
        const ref = scopeThreadRef(thread.environmentId, thread.id);
        const selected = props.activeThreadKey === scopedThreadKey(ref);
        const status = subagentThreadListStatus(thread);
        return (
          <li key={thread.id}>
            <button
              type="button"
              aria-label={`${thread.title}, ${status}`}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected && "bg-sidebar-row-active text-sidebar-foreground",
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                props.onNavigate(event, ref);
              }}
            >
              {status === "In progress" ? (
                <Spinner aria-hidden size="xs" tone="accent" className="shrink-0" />
              ) : status === "Approval needed" ? (
                <ShieldQuestionIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
              ) : status === "Input needed" ? (
                <MessageCircleQuestionIcon aria-hidden className="size-3.5 shrink-0 text-info" />
              ) : status === "Failed" ? (
                <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-error" />
              ) : status === "Completed" ? (
                <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
              ) : (
                <PauseIcon aria-hidden className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{thread.title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

import {
  SidebarSubagentDisclosure,
  SidebarSubagentRows,
  useSidebarSubagents,
} from "./SidebarSubagentRows";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { useState } from "react";
import { AlarmClockOffIcon, CheckIcon, PinIcon, Undo2Icon } from "lucide-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  resolveSidebarThreadStatus,
  hasUnseenCompletion,
  resolveThreadLastVisitedAt,
  sidebarSortableStyle,
  useSidebarRowSubscriptionLease,
  type SidebarSortableBag,
} from "../Sidebar.logic";
import { ThreadBranchIndicator, useLinkedThreadPullRequest } from "../ThreadStatusIndicators";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { Spinner } from "../ui/spinner";
import { useUiStateStore } from "../../uiStateStore";
import type { WorkspaceChatSession } from "@t3tools/client-runtime/state/workspace-chat-sessions";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useEnvironmentScope } from "../../state/session";
import { useSidebarSortableRow } from "./SidebarThreadRow";

type SidebarTabSessionRowProps = {
  session: WorkspaceChatSession;
  sortable?: SidebarSortableBag | undefined;
  dragPreview?: boolean;
  dimmed?: boolean;
  projectIcon?: ProjectFaviconProject | null;
  isActive: boolean;
  activeThreadKey: string | null;
  jumpLabel: string | null;
  onNavigate: (thread: ScopedThreadRef) => void;
  onContextMenu: (thread: ScopedThreadRef, position: { x: number; y: number }) => void;
  primaryAction: {
    kind: "settle" | "unsettle" | "unsnooze";
    onSelect: (thread: ScopedThreadRef) => void;
  } | null;
};

export function SortableTabSessionRow(
  props: Omit<SidebarTabSessionRowProps, "sortable"> & {
    sortableId: string;
    sortableDisabled: boolean;
    contextDrag: boolean;
  },
) {
  const { sortableId, sortableDisabled, contextDrag, ...rowProps } = props;
  const bag = useSidebarSortableRow({
    id: sortableId,
    disabled: sortableDisabled,
    contextDrag,
    environmentId: rowProps.session.thread.environmentId,
  });
  return <SidebarTabSessionRow {...rowProps} sortable={bag} />;
}

/** One sidebar row for a workspace's chat tabs. Settle, snooze, pin and
 * reorder move every tab (see useThreadActions); rename and delete still
 * target the selected chat. */
export function SidebarTabSessionRow(props: SidebarTabSessionRowProps) {
  const { session } = props;
  const threadRef = scopeThreadRef(session.thread.environmentId, session.thread.id);
  const subagents = useSidebarSubagents(threadRef);
  const childSelected = subagents.all.some(
    (child) =>
      scopedThreadKey(scopeThreadRef(child.environmentId, child.id)) === props.activeThreadKey,
  );
  const canOperateThread = useEnvironmentScope(
    session.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const primaryAction = canOperateThread ? props.primaryAction : null;
  const actionLabel =
    primaryAction?.kind === "unsnooze"
      ? "Wake thread now"
      : primaryAction?.kind === "unsettle"
        ? "Un-settle thread"
        : "Settle thread";
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const sortable = props.sortable;
  const attachRow = (node: HTMLLIElement | null) => {
    sortable?.setNodeRef(node);
    rowRef(node);
  };
  const pr = useLinkedThreadPullRequest(
    session.thread.environmentId,
    session.thread.linkedPullRequest,
    leaseLiveStatus,
    session.thread.pullRequests,
    session.thread.branchPullRequest,
  )?.pr;
  const branchTone =
    pr && (pr.state === "open" || pr.state === "merged")
      ? resolvePullRequestState({ state: pr.state, isDraft: false }).toneClassName
      : undefined;
  const isUnread = useUiStateStore((state) =>
    session.chats.some((chat) =>
      hasUnseenCompletion({
        ...chat,
        lastVisitedAt: resolveThreadLastVisitedAt(
          chat.lastVisitedAt,
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(chat.environmentId, chat.id))
          ],
        ),
      }),
    ),
  );
  const statuses = new Set(session.chats.map(resolveSidebarThreadStatus));
  const status = statuses.has("approval")
    ? "Approval"
    : statuses.has("input")
      ? "Input"
      : statuses.has("working")
        ? "Working"
        : statuses.has("failed")
          ? "Failed"
          : statuses.has("limited")
            ? "Limited"
            : null;
  const relativeTime = formatRelativeTimeLabel(session.latestSentAt);
  const time = relativeTime === "just now" ? "now" : relativeTime.replace(/ ago$/, "");
  return (
    <li
      ref={attachRow}
      {...(sortable ? { style: sidebarSortableStyle(sortable), ...sortable.listeners } : {})}
      data-thread-item={props.dragPreview ? undefined : scopedThreadKey(threadRef)}
      data-tab-session={props.dragPreview ? undefined : session.key}
      className={cn(
        "list-none transition-opacity duration-150 motion-reduce:transition-none",
        props.dimmed && !props.dragPreview && "opacity-30",
        sortable?.isDragging && "relative z-20",
      )}
    >
      <div
        className={cn(
          "group/session flex h-9 items-center gap-1 rounded-md",
          props.isActive || childSelected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <Tooltip disabled={props.dragPreview || sortable?.isDragging}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-current={props.isActive ? "page" : undefined}
                aria-label={`${session.title}, ${session.chats.length} chat tabs${status ? `, ${status}` : ""}`}
                onClick={() => props.onNavigate(threadRef)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  props.onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
                }}
                className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md pl-7 text-left text-sm text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            {props.projectIcon ? (
              <ProjectFavicon project={props.projectIcon} className="size-3.5 shrink-0" />
            ) : null}
            {statuses.has("working") ? (
              <Spinner aria-hidden size="xs" tone="accent" className="shrink-0" />
            ) : (
              <ThreadBranchIndicator thread={session.thread} toneClassName={branchTone} />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate group-hover/session:text-sidebar-foreground group-focus-within/session:text-sidebar-foreground",
                // Bold until every tab is reviewed, even while a sibling works.
                isUnread ? "font-bold" : "font-normal",
                status === null && !isUnread && !props.isActive
                  ? "text-sidebar-muted-foreground"
                  : "text-sidebar-foreground",
                statuses.has("working") && "text-sidebar-foreground/85",
              )}
            >
              {session.title}
            </span>
            {session.section === "pinned" ? (
              <PinIcon aria-hidden className="size-3 shrink-0" />
            ) : null}
            <span
              className={cn(
                "shrink-0 text-xs",
                (status === "Approval" || status === "Input" || status === "Limited") &&
                  "text-warning",
                status === "Failed" && "text-error",
              )}
            >
              {props.jumpLabel ?? (status === "Working" ? time : (status ?? time))}
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            {session.title} · {session.chats.length} chat tabs
          </TooltipPopup>
        </Tooltip>
        <SidebarSubagentDisclosure
          count={subagents.threads.length}
          expanded={subagents.expanded}
          onToggle={() => subagents.setExpanded((expanded) => !expanded)}
        />
        <span className="relative mr-1 flex h-7 min-w-7 shrink-0 items-center justify-end">
          <Menu open={tabMenuOpen} onOpenChange={setTabMenuOpen}>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Chat tabs in ${session.title}`}
                  className={cn(
                    "peer flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md px-1 text-xs tabular-nums text-sidebar-muted-foreground transition-opacity hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    primaryAction !== null &&
                      !tabMenuOpen &&
                      "not-focus-visible:group-any-hover/session:pointer-events-none not-focus-visible:group-any-hover/session:opacity-0",
                  )}
                />
              }
            >
              {session.chats.length}
            </MenuTrigger>
            <MenuPopup side="right" align="start">
              {session.chats.map((chat) => (
                <MenuItem
                  key={chat.id}
                  onClick={() => props.onNavigate(scopeThreadRef(chat.environmentId, chat.id))}
                >
                  <CheckIcon
                    aria-hidden
                    className={cn("size-3.5", chat.id !== session.thread.id && "invisible")}
                  />
                  {chat.title}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                onClick={(event) =>
                  props.onContextMenu(threadRef, { x: event.clientX, y: event.clientY })
                }
              >
                Current chat actions
              </MenuItem>
            </MenuPopup>
          </Menu>
          {primaryAction !== null && !tabMenuOpen ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={actionLabel}
                    onClick={() => primaryAction.onSelect(threadRef)}
                    className="pointer-events-none absolute inset-0 inline-flex cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-any-hover/session:pointer-events-auto group-any-hover/session:opacity-100 peer-focus-visible:pointer-events-none peer-focus-visible:opacity-0"
                  />
                }
              >
                {primaryAction.kind === "unsnooze" ? (
                  <AlarmClockOffIcon aria-hidden className="size-3" />
                ) : primaryAction.kind === "unsettle" ? (
                  <Undo2Icon aria-hidden className="size-3.5" />
                ) : (
                  <CheckIcon aria-hidden className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup>{actionLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      </div>
      <SidebarSubagentRows
        threads={subagents.threads}
        expanded={subagents.expanded}
        activeThreadKey={props.activeThreadKey}
        onNavigate={(_event, ref) => props.onNavigate(ref)}
      />
    </li>
  );
}

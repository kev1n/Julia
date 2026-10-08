import { CheckIcon, GitBranchIcon, PinIcon } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import type { WorkspaceChatSession } from "../chat/workspaceChatTabs.logic";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

/** Session actions select a chat; lifecycle actions still target that chat,
 * never silently settle, rename or delete the other tabs in its workspace. */
export function SidebarTabSessionRow(props: {
  session: WorkspaceChatSession;
  isActive: boolean;
  jumpLabel: string | null;
  onNavigate: (thread: ScopedThreadRef) => void;
  onContextMenu: (thread: ScopedThreadRef, position: { x: number; y: number }) => void;
}) {
  const { session } = props;
  const threadRef = scopeThreadRef(session.thread.environmentId, session.thread.id);
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
            : statuses.has("waiting")
              ? "Waiting"
              : null;
  const relativeTime = formatRelativeTimeLabel(session.latestSentAt);
  const time = relativeTime === "just now" ? "now" : relativeTime.replace(/ ago$/, "");
  return (
    <li
      data-thread-item={scopedThreadKey(threadRef)}
      data-tab-session={session.key}
      className="list-none"
    >
      <div
        className={cn(
          "group/session flex h-9 items-center gap-1 rounded-md",
          props.isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <Tooltip>
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
                className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md pl-2.5 text-left text-sm text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <GitBranchIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0",
                props.isActive ? "text-sidebar-branch-active" : "text-sidebar-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate font-normal text-sidebar-muted-foreground">
              {session.title}
            </span>
            {session.section === "pinned" ? (
              <PinIcon aria-hidden className="size-3 shrink-0" />
            ) : null}
            <span
              className={cn(
                "shrink-0 text-xs",
                status === "Working" && "text-info",
                (status === "Approval" || status === "Input" || status === "Limited") &&
                  "text-warning",
                status === "Failed" && "text-error",
              )}
            >
              {props.jumpLabel ?? status ?? time}
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            {session.title} · {session.chats.length} chat tabs
          </TooltipPopup>
        </Tooltip>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`Chat tabs in ${session.title}`}
                className="mr-1 flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md px-1 text-xs tabular-nums text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      </div>
    </li>
  );
}

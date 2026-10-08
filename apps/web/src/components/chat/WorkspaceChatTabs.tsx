import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, MessageSquareIcon, PlusIcon, XIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ForkChatMenu } from "./ForkChatMenu";
import { workspaceChatKey } from "./workspaceChatTabs.logic";

const CLOSED_TABS = Schema.Array(Schema.String);
const EMPTY_TABS: readonly string[] = [];

export function WorkspaceChatTabs(props: {
  activeThread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "projectId" | "worktreePath" | "title" | "chatGroupId"
  >;
  isServerThread: boolean;
  canCreate: boolean;
  canFork: boolean;
  onNewChat: () => void;
  onForkChat: (destination: "tab" | "thread") => Promise<void>;
}) {
  const projectRefs = useMemo(
    () => [scopeProjectRef(props.activeThread.environmentId, props.activeThread.projectId)],
    [props.activeThread.environmentId, props.activeThread.projectId],
  );
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const navigate = useNavigate();
  const workspaceKey = workspaceChatKey(props.activeThread);
  const [closed, setClosed] = useLocalStorage(
    `t3code:closed-chat-tabs:${workspaceKey}`,
    EMPTY_TABS,
    CLOSED_TABS,
  );
  const closingRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const chats = useMemo(
    () =>
      threads
        .filter(
          (thread) =>
            thread.archivedAt === null &&
            thread.lineage.relationshipToParent !== "subagent" &&
            workspaceChatKey(thread) === workspaceKey,
        )
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    [threads, workspaceKey],
  );
  const visible = chats.filter(
    (thread) => thread.id === props.activeThread.id || !closed.includes(thread.id),
  );
  const hidden = chats.filter(
    (thread) => thread.id !== props.activeThread.id && closed.includes(thread.id),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reopens a closed tab when navigation lands on it from outside the tab bar
  useEffect(() => {
    if (closingRef.current === props.activeThread.id) return;
    closingRef.current = null;
    if (closed.includes(props.activeThread.id))
      setClosed((ids) => ids.filter((id) => id !== props.activeThread.id));
  }, [closed, props.activeThread.id, setClosed]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls and focuses the active tab in the DOM
  useEffect(() => {
    const tab = viewportRef.current?.querySelector<HTMLElement>(
      `[data-chat-tab-id="${CSS.escape(props.activeThread.id)}"]`,
    );
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (viewportRef.current?.contains(document.activeElement)) tab?.focus();
  }, [props.activeThread.id]);
  const openChat = (thread: EnvironmentThreadShell) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  const closeChat = async (thread: EnvironmentThreadShell) => {
    if (thread.id === props.activeThread.id) {
      const index = visible.findIndex((chat) => chat.id === thread.id);
      const next = visible[index + 1] ?? visible[index - 1];
      if (!next) return;
      closingRef.current = thread.id;
      try {
        await openChat(next);
      } finally {
        closingRef.current = null;
      }
    }
    setClosed((ids) => [...new Set([...ids, thread.id])]);
  };
  const actionClass =
    "flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-40";
  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border/60 px-3"
      data-workspace-chat-tabs
    >
      <div
        ref={viewportRef}
        role="tablist"
        aria-label="Workspace chats"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {visible.map((thread) => {
          const active = props.isServerThread && thread.id === props.activeThread.id;
          return (
            <div
              key={thread.id}
              className={cn(
                "group/chat-tab flex h-10 max-w-56 shrink-0 items-center border-b-2",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground",
              )}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      data-chat-tab-id={thread.id}
                      onClick={() => void openChat(thread)}
                      onKeyDown={(event) => {
                        const index = visible.findIndex((chat) => chat.id === thread.id);
                        const next =
                          event.key === "ArrowRight"
                            ? visible[(index + 1) % visible.length]
                            : event.key === "ArrowLeft"
                              ? visible[(index + visible.length - 1) % visible.length]
                              : event.key === "Home"
                                ? visible[0]
                                : event.key === "End"
                                  ? visible.at(-1)
                                  : undefined;
                        if (!next) return;
                        event.preventDefault();
                        void openChat(next).then(() => {
                          // Chat navigation remounts this tab strip. Restore
                          // keyboard focus on the destination, not the old ref.
                          document
                            .querySelector<HTMLElement>(
                              `[data-workspace-chat-tabs] [data-chat-tab-id="${CSS.escape(next.id)}"]`,
                            )
                            ?.focus();
                        });
                      }}
                      className="flex h-10 min-w-0 cursor-pointer items-center gap-2 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">{thread.title}</span>
                </TooltipTrigger>
                <TooltipPopup>{thread.title}</TooltipPopup>
              </Tooltip>
              {visible.length > 1 || !props.isServerThread ? (
                <button
                  type="button"
                  aria-label={`Close chat tab ${thread.title}`}
                  onClick={() => void closeChat(thread)}
                  className="flex h-10 w-7 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
        {!props.isServerThread ? (
          <span
            role="tab"
            tabIndex={0}
            aria-selected="true"
            className="flex h-10 shrink-0 items-center border-b-2 border-foreground px-2 text-sm"
          >
            New chat
          </span>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="New chat in this workspace"
              disabled={!props.canCreate}
              onClick={props.onNewChat}
              className={actionClass}
            />
          }
        >
          <PlusIcon aria-hidden className="size-4" />
        </TooltipTrigger>
        <TooltipPopup>New chat in this workspace</TooltipPopup>
      </Tooltip>
      <ForkChatMenu
        size="icon-lg"
        label="Fork chat"
        disabled={!props.canFork}
        onFork={props.onForkChat}
      />
      {hidden.length > 0 ? (
        <Menu>
          <MenuTrigger
            render={<button type="button" aria-label="Reopen a chat tab" className={actionClass} />}
          >
            <ChevronDownIcon aria-hidden className="size-4" />
          </MenuTrigger>
          <MenuPopup>
            {hidden.map((thread) => (
              <MenuItem
                key={thread.id}
                onClick={() => {
                  setClosed((ids) => ids.filter((id) => id !== thread.id));
                  void openChat(thread);
                }}
              >
                {thread.title}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

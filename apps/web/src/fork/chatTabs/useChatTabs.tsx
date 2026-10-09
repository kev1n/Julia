/**
 * Fork (Owner): the chat tab strip's actions for ChatView. A new tab (+, Cmd+T)
 * opens a fresh chat in the same workspace that can bring in the context of the
 * chat it came from; Fork chat copies the current chat into a tab or thread.
 */
import type { RunId, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { GitForkIcon } from "lucide-react";
import { useState } from "react";

import { setChatTabOrigin, useChatTabOriginStore } from "../../components/chat/chatTabOrigins";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { newThreadId } from "../../lib/utils";
import { waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";

export function useChatTabs(input: {
  readonly activeThread:
    | Pick<
        EnvironmentThreadShell,
        "environmentId" | "id" | "title" | "branch" | "worktreePath" | "chatGroupId"
      >
    | null
    | undefined;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly isServerThread: boolean;
  readonly draftId: DraftId | null;
  /** The run a fork would copy up to, once the chat is able to fork. */
  readonly forkRunId: RunId | null;
  readonly onForkFromRun: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
    readonly destination: "tab" | "thread";
  }) => Promise<void>;
}) {
  const { activeThread, activeProjectRef, draftId, forkRunId } = input;
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });

  const newChatTab = async () => {
    if (!activeThread || !activeProjectRef) return;
    const created = await handleNewThread(activeProjectRef, {
      branch: activeThread.branch,
      worktreePath: activeThread.worktreePath,
      chatGroupId: activeThread.chatGroupId,
      envMode: activeThread.worktreePath ? "worktree" : "local",
    });
    // A tab opened from a draft keeps whatever origin that draft already had.
    if (!created || !input.isServerThread) return;
    setChatTabOrigin(
      created.draftId,
      forkRunId
        ? {
            threadRef: scopeThreadRef(activeThread.environmentId, activeThread.id),
            runId: forkRunId,
            title: activeThread.title,
            chatGroupId: activeThread.chatGroupId ?? null,
          }
        : null,
    );
  };
  const forkChat = async (destination: "tab" | "thread") => {
    if (!activeThread || !forkRunId) return;
    await input.onForkFromRun({ sourceThreadId: activeThread.id, runId: forkRunId, destination });
  };

  const chatTabOrigin = useChatTabOriginStore((state) =>
    draftId === null ? null : (state.byDraftId[draftId] ?? null),
  );
  const [isBringingInContext, setIsBringingInContext] = useState(false);
  // Swaps this new-tab draft for a fork of the chat it was opened from, keeping
  // whatever the user has already typed.
  const bringInChatTabOrigin = async () => {
    if (!chatTabOrigin || draftId === null || isBringingInContext) return;
    const origin = chatTabOrigin;
    setIsBringingInContext(true);
    try {
      const targetThreadRef = scopeThreadRef(origin.threadRef.environmentId, newThreadId());
      const result = await forkThreadFromRun({
        environmentId: origin.threadRef.environmentId,
        input: {
          sourceThreadId: origin.threadRef.threadId,
          targetThreadId: targetThreadRef.threadId,
          runId: origin.runId,
          title: `${origin.title} fork`,
          contextMode: "without_tool_results",
          destination: "tab",
          chatGroupId: origin.chatGroupId,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not bring in that chat's context",
            ...(error instanceof Error ? { description: error.message } : {}),
          });
        }
        return;
      }
      if (!(await waitForThreadShell(targetThreadRef))) {
        toastManager.add({
          type: "error",
          title: "The fork was created, but its thread did not reach this client",
          description: "Reconnect and open it from the sidebar.",
        });
        return;
      }
      const draftStore = useComposerDraftStore.getState();
      draftStore.moveComposerPromptAndImages(draftId, targetThreadRef);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(targetThreadRef),
        replace: true,
      });
      draftStore.clearDraftThread(draftId);
      setChatTabOrigin(draftId, null);
    } finally {
      setIsBringingInContext(false);
    }
  };

  return {
    newChatTab,
    forkChat,
    /** The "Bring in context" button for a new-tab draft, or null. */
    bringInContextButton: (disabled: boolean) =>
      chatTabOrigin ? (
        <div className="mt-3 flex justify-center">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isBringingInContext || disabled}
            onClick={() => void bringInChatTabOrigin()}
          >
            <GitForkIcon aria-hidden />
            <span className="truncate">Bring in context from {chatTabOrigin.title}</span>
          </Button>
        </div>
      ) : null,
  };
}

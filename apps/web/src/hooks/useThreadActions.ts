import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import { useRouter } from "@tanstack/react-router";

import { getFallbackThreadIdAfterDelete, pinOrderKeyBetween } from "../components/Sidebar.logic";
import {
  workspaceChatKey,
  workspaceChatTabs,
} from "@t3tools/client-runtime/state/workspace-chat-sessions";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { orchestrationEnvironment } from "../state/orchestration";
import { projectEnvironment } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { announce } from "../lib/announce";
import { m } from "../i18n/messages";
import { readLocalApi } from "../localApi";
import {
  readDelegatedUnderParent,
  readEnvironmentServerConfigLoaded,
  readEnvironmentThreadRefs,
  readProject,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { clearThreadPreviewState } from "../previewStateStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings } from "./useSettings";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { useAtomCommand } from "../state/use-atom-command";
import { threadTriagePermitted, useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

export class ThreadArchiveBlockedError extends Schema.TaggedError<ThreadArchiveBlockedError>()(
  "ThreadArchiveBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(msg("Cannot archive while the provider is active."));
  }
}

export class ThreadSettlementUnsupportedError extends Schema.TaggedError<ThreadSettlementUnsupportedError>()(
  "ThreadSettlementUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg(
        "This environment's server does not support settling yet. Update the server to use Settle.",
      ),
    );
  }
}

export class ThreadSnoozeUnsupportedError extends Schema.TaggedError<ThreadSnoozeUnsupportedError>()(
  "ThreadSnoozeUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg(
        "This environment's server does not support snoozing yet. Update the server to use Snooze.",
      ),
    );
  }
}

export class ThreadSnoozeBlockedError extends Schema.TaggedError<ThreadSnoozeBlockedError>()(
  "ThreadSnoozeBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg("This thread is waiting on you. Respond to the pending request before snoozing it."),
    );
  }
}

function topOfPinnedRunOrderKey(): string | undefined {
  let firstKey: string | null = null;
  for (const shell of readThreadShells()) {
    if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
    if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}

/** `target` plus the other tabs in its strip that `include` accepts. Settle
    and snooze move a tabbed thread as one, or it lingers until every tab is
    parked separately. */
function readTabRefs(
  target: ScopedThreadRef,
  include: (chat: EnvironmentThreadShell) => boolean,
): ScopedThreadRef[] {
  const thread = readThreadShell(target);
  if (!thread) return [target];
  return [
    target,
    ...workspaceChatTabs(readThreadShells(), workspaceChatKey(thread))
      .filter((chat) => chat.id !== thread.id && include(chat))
      .map((chat) => scopeThreadRef(chat.environmentId, chat.id)),
  ];
}

/** One Undo for every tab an action moved; acting on any of them again expires it. */
function claimTabs(kind: string, refs: readonly ScopedThreadRef[]) {
  const claims = refs.map((ref) => ThreadUndo.begin(kind, scopedThreadKey(ref)));
  return {
    isCurrent: () => claims.every((claim) => claim.isCurrent()),
    finish: () => {
      for (const claim of claims) claim.finish();
    },
  };
}

function firstFailure<R extends { readonly _tag: string }>(results: readonly R[]): R {
  return results.find((result) => result._tag !== "Success") ?? results[0]!;
}

/** A strip sorts as one row, so a move writes the same key to every tab. The
    server rejects tabs outside the order (a fresh failover tab is unpinned in
    a pinned strip), and local shells may still predate a move that just
    landed, so the move succeeds when any tab took the key. */
async function moveTabs<R extends { readonly _tag: string }>(
  target: ScopedThreadRef,
  move: (ref: ScopedThreadRef) => Promise<R>,
): Promise<R> {
  const results = await Promise.all(readTabRefs(target, () => true).map(move));
  return results.find((result) => result._tag === "Success") ?? results[0]!;
}

export class ThreadPinningUnsupportedError extends Schema.TaggedError<ThreadPinningUnsupportedError>()(
  "ThreadPinningUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg("This environment's server does not support pinning yet. Update the server to use Pin."),
    );
  }
}

export class ThreadPinReorderUnsupportedError extends Schema.TaggedError<ThreadPinReorderUnsupportedError>()(
  "ThreadPinReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg(
        "This environment's server does not support reordering pinned threads yet. Update the server to reorder pins.",
      ),
    );
  }
}

export class ThreadActiveReorderUnsupportedError extends Schema.TaggedError<ThreadActiveReorderUnsupportedError>()(
  "ThreadActiveReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(msg("Update this environment's server to reorder active threads."));
  }
}

async function requestThreadUnpinConfirmation(input: {
  enabled: boolean;
  title: string | null;
  confirm: ((message: string) => Promise<boolean>) | null;
}) {
  const { confirm } = input;
  if (!input.enabled || confirm === null) {
    return AsyncResult.success(true);
  }

  return settlePromise(() =>
    confirm(
      [
        input.title === null
          ? m(msg('Unpin thread "this thread"?'))
          : m(msg('Unpin thread "{title}"?', { title: input.title })),
        m(msg("This will move the thread out of your pinned section.")),
      ].join("\n"),
    ),
  );
}

export async function navigateAfterThreadDeletion(navigate: () => Promise<void>) {
  const result = await settlePromise(navigate);
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Thread deleted, but navigation failed")),
        description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
      }),
    );
  }
}

function useMarkThreadUnread() {
  const markThreadUnreadMutation = useAtomCommand(threadEnvironment.markUnread, {
    reportFailure: false,
  });
  const markThreadUnreadLocal = useUiStateStore((state) => state.markThreadUnread);
  return (target: ScopedThreadRef) => {
    if (readEnvironmentServerConfigLoaded(target.environmentId)) {
      void markThreadUnreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      return;
    }
    const thread = readThreadShell(target);
    markThreadUnreadLocal(scopedThreadKey(target), thread?.latestRun?.completedAt);
  };
}

export function useAcknowledgeThreadWoke() {
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  return (target: ScopedThreadRef, wokeAt: string) => {
    if (readEnvironmentServerConfigLoaded(target.environmentId)) {
      void visitThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, visitedAt: wokeAt },
      });
      return;
    }
    markThreadVisited(scopedThreadKey(target), wokeAt);
  };
}

// These Undos restore a thread's place in the list, which archiving or deleting it ends.
const LIST_PLACEMENT_UNDO_KINDS = ["settle", "snooze", "pin"];

function expireThreadUndos(target: ScopedThreadRef, kinds: readonly string[]) {
  for (const kind of kinds) ThreadUndo.invalidate(kind, scopedThreadKey(target));
}

function clearDeletedThreadPanelState(ref: ScopedThreadRef) {
  clearThreadPreviewState(ref);
  useRightPanelStore.getState().removeThread(ref);
  useDiffPanelStore.getState().removeThread(ref);
  usePreviewMiniPlayerStore.getState().removeThread(ref);
}

/** A No project thread that already has its own folder, on a server that can promote it. */
export function canTurnThreadIntoProject(threadRef: ScopedThreadRef): boolean {
  const thread = readThreadShell(threadRef);
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  if (!thread?.worktreePath || config?.environment.capabilities.threadProjectFromScratch !== true) {
    return false;
  }
  const project = readProject({
    environmentId: threadRef.environmentId,
    projectId: thread.projectId,
  });
  return project !== null && isScratchProject(project, config.scratchWorkspaceRoot);
}

function threadOperationFailure(target: ScopedThreadRef) {
  return readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
    ? null
    : AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: m(msg("This connection cannot change threads.")),
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );
}

export function useThreadActions() {
  const archiveThreadMutation = useOrchestrationCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useOrchestrationCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const settleThreadMutation = useOrchestrationCommand(
    threadEnvironment.settle,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const unsettleThreadMutation = useOrchestrationCommand(
    threadEnvironment.unsettle,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const pinThreadMutation = useOrchestrationCommand(threadEnvironment.pin, {
    reportFailure: false,
  });
  const unpinThreadMutation = useOrchestrationCommand(threadEnvironment.unpin, {
    reportFailure: false,
  });
  const reorderPinnedThreadMutation = useOrchestrationCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveThreadMutation = useOrchestrationCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const snoozeThreadMutation = useOrchestrationCommand(
    threadEnvironment.snooze,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const unsnoozeThreadMutation = useOrchestrationCommand(
    threadEnvironment.unsnooze,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const markThreadUnread = useMarkThreadUnread();
  const createProjectFromThread = useAtomCommand(projectEnvironment.createFromThread, {
    reportFailure: false,
  });
  const stopThreadSession = useOrchestrationCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const loadSessionState = useAtomQueryRunner(environmentSession.sessionStateAtom, {
    reportFailure: false,
  });
  const loadWorktreeThreadIds = useAtomQueryRunner(orchestrationEnvironment.worktreeThreadIds, {
    reportFailure: false,
    refresh: true,
  });
  const loadThreadFamily = useAtomQueryRunner(orchestrationEnvironment.threadFamily, {
    reportFailure: false,
    refresh: true,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const confirmThreadUnpin = useClientSettings((settings) => settings.confirmThreadUnpin);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalUiState = useTerminalUiStateStore((state) => state.clearTerminalUiState);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();

  const resolveThreadTarget = (target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  };
  const getCurrentRouteThreadRef = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  };

  const unarchiveThread = async (target: ScopedThreadRef, opts: { navigate?: boolean } = {}) => {
    ThreadUndo.invalidate("archive", scopedThreadKey(target));
    const result = await unarchiveThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Failure") {
      return result;
    }
    refreshArchivedThreadsForEnvironment(target.environmentId);
    if (opts.navigate) {
      return settlePromise(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target),
        }),
      );
    }
    return result;
  };

  const archiveThread = async (target: ScopedThreadRef, opts: { onArchived?: () => void } = {}) => {
    const resolved = resolveThreadTarget(target);
    if (!resolved) return AsyncResult.success(undefined);
    const { thread, threadRef } = resolved;
    if (!threadRuntimeCanArchive(thread.runtime)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadArchiveBlockedError({
            environmentId: threadRef.environmentId,
            threadId: threadRef.threadId,
          }),
        ),
      );
    }

    const requestingRouteHref = router.state.location.href;
    const currentRouteThreadRef = getCurrentRouteThreadRef();
    const shouldNavigateToDraft =
      currentRouteThreadRef?.threadId === threadRef.threadId &&
      currentRouteThreadRef.environmentId === threadRef.environmentId;
    const action = ThreadUndo.begin("archive", scopedThreadKey(threadRef));
    const archiveResult = await archiveThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (archiveResult._tag === "Failure") {
      action.finish();
      return archiveResult;
    }
    expireThreadUndos(threadRef, LIST_PLACEMENT_UNDO_KINDS);
    const wokeAt = threadWokeAt(thread, { now: new Date().toISOString() });
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(threadRef), wokeAt);
    }
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    opts.onArchived?.();
    showThreadUndoNotice({
      action: "Archived",
      claim: action,
      undo: () => unarchiveThread(threadRef, { navigate: shouldNavigateToDraft }),
      failureTitle: m(msg("Failed to undo archive")),
    });

    if (shouldNavigateToDraft && router.state.location.href === requestingRouteHref) {
      const navigationResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (navigationResult._tag === "Failure") {
        return navigationResult;
      }
      return archiveResult;
    }

    return archiveResult;
  };

  const deleteThread = async (
    target: ScopedThreadRef,
    opts: { deletedThreadKeys?: ReadonlySet<string> } = {},
  ) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const resolved = resolveThreadTarget(target);
    if (!resolved) {
      let threads = readEnvironmentThreadRefs(target.environmentId).flatMap((ref) => {
        const shell = readThreadShell(ref);
        return shell === null ? [] : [{ id: shell.id, lineage: shell.lineage }];
      });
      if (
        appAtomRegistry.get(environmentServerConfigsAtom).get(target.environmentId)
          ?.shellThreadFamilies
      ) {
        const family = await loadThreadFamily({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
        if (family._tag === "Success") threads = [...family.value.threads];
      }
      const result = await deleteThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Success") {
        for (const ref of [
          target,
          ...threads
            .filter(
              (entry) =>
                entry.lineage.sideChat === true && entry.lineage.parentThreadId === target.threadId,
            )
            .map((entry) => scopeThreadRef(target.environmentId, entry.id)),
        ]) {
          releaseComposerDraftUploads(ref);
          clearComposerDraftForThread(ref);
        }
        expireThreadUndos(target, [...LIST_PLACEMENT_UNDO_KINDS, "archive"]);
        refreshArchivedThreadsForEnvironment(target.environmentId);
        clearTerminalUiState(target);
        clearDeletedThreadPanelState(target);
      }
      return result;
    }
    const { thread, threadRef } = resolved;
    const threads = readEnvironmentThreadRefs(threadRef.environmentId).flatMap((ref) => {
      const shell = readThreadShell(ref);
      return shell === null ? [] : [shell];
    });
    const threadProject = readProject({
      environmentId: threadRef.environmentId,
      projectId: thread.projectId,
    });
    const deletedIds =
      opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
        ? new Set<ThreadId>(
            [...opts.deletedThreadKeys].flatMap((threadKey) => {
              const ref = parseScopedThreadKey(threadKey);
              return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
            }),
          )
        : undefined;
    // Deleting a thread also deletes its side chats, which share its worktree.
    const removedIds = new Set<ThreadId>(deletedIds);
    for (const entry of threads) {
      if (entry.lineage.sideChat === true && entry.lineage.parentThreadId === threadRef.threadId) {
        removedIds.add(entry.id);
      }
    }
    const survivingThreads = threads.filter(
      (entry) => entry.id === threadRef.threadId || !removedIds.has(entry.id),
    );
    const environmentConfig = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(threadRef.environmentId);
    let orphanedWorktreePath = getOrphanedWorktreePathForThread(
      survivingThreads,
      threadRef.threadId,
    );
    // A shell that leaves idle subagent children out cannot prove nobody else uses the worktree,
    // so the server's list decides. A failed read keeps the worktree.
    if (orphanedWorktreePath !== null && environmentConfig?.shellThreadFamilies === true) {
      const occupants = await loadWorktreeThreadIds({
        environmentId: threadRef.environmentId,
        input: { worktreePath: orphanedWorktreePath },
      });
      if (
        occupants._tag !== "Success" ||
        occupants.value.threadIds.some(
          (threadId) => threadId !== threadRef.threadId && !removedIds.has(threadId),
        )
      ) {
        orphanedWorktreePath = null;
      }
    }
    const displayWorktreePath = orphanedWorktreePath
      ? formatWorktreePathForDisplay(orphanedWorktreePath)
      : null;
    const localApi = readLocalApi();
    let canDeleteWorktree = false;
    if (
      orphanedWorktreePath !== null &&
      threadProject !== null &&
      !isScratchProject(threadProject, environmentConfig?.scratchWorkspaceRoot) &&
      localApi
    ) {
      const sessionResult = await loadSessionState(threadRef.environmentId);
      const permissionFailure = threadOperationFailure(threadRef);
      if (permissionFailure) return permissionFailure;
      canDeleteWorktree =
        sessionResult._tag === "Success" &&
        sessionGrantsScope(sessionResult.value, AuthSourceControlWriteScope);
    }
    let shouldDeleteWorktree = false;
    const environmentSettings = environmentConfig?.settings;
    const automaticWorktreeCleanup = environmentSettings
      ? resolveWorktreeCleanup(environmentSettings, thread.projectId).worktreeOnDelete
      : false;
    if (canDeleteWorktree && localApi && !automaticWorktreeCleanup) {
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [
            m(msg("This thread is the only one linked to this worktree:")),
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            m(msg("Delete the worktree too?")),
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      shouldDeleteWorktree = confirmationResult.value;
    }

    if (thread.runtime !== null) {
      await stopThreadSession({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    }

    const deletedThreadIds = deletedIds ?? new Set<ThreadId>();
    const currentRouteThreadRef = getCurrentRouteThreadRef();
    const shouldNavigateToFallback =
      currentRouteThreadRef?.threadId === threadRef.threadId &&
      currentRouteThreadRef.environmentId === threadRef.environmentId;
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads,
      deletedThreadId: threadRef.threadId,
      deletedThreadIds,
      sortOrder: sidebarThreadSortOrder,
      now: new Date().toISOString(),
      delegatedUnderParent: readDelegatedUnderParent(),
    });
    let navigatedDuringDelete = false;
    // The missing-thread redirect and the index draft replace this entry; any other history
    // action while the delete is pending is the user's own choice, which must win.
    const stopWatchingHistory = router.history.subscribe(({ action }) => {
      if (action.type !== "REPLACE") navigatedDuringDelete = true;
    });
    const deleteResult = await deleteThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).finally(stopWatchingHistory);
    if (deleteResult._tag === "Failure") {
      return deleteResult;
    }
    expireThreadUndos(threadRef, [...LIST_PLACEMENT_UNDO_KINDS, "archive"]);
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    releaseComposerDraftUploads(threadRef);
    clearComposerDraftForThread(threadRef);
    // The server deletes the thread's side chats with it.
    for (const entry of threads) {
      if (entry.lineage.sideChat !== true || entry.lineage.parentThreadId !== threadRef.threadId) {
        continue;
      }
      const sideChatRef = scopeThreadRef(threadRef.environmentId, entry.id);
      releaseComposerDraftUploads(sideChatRef);
      clearComposerDraftForThread(sideChatRef);
    }
    clearProjectDraftThreadById(
      scopeProjectRef(threadRef.environmentId, thread.projectId),
      threadRef,
    );
    clearTerminalUiState(threadRef);
    clearDeletedThreadPanelState(threadRef);

    if (shouldNavigateToFallback && !navigatedDuringDelete) {
      const fallbackThread = fallbackThreadId
        ? readThreadShell(scopeThreadRef(threadRef.environmentId, fallbackThreadId))
        : null;
      await navigateAfterThreadDeletion(() =>
        fallbackThread
          ? router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            })
          : router.navigate({ to: "/", replace: true }),
      );
    }

    if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
      return deleteResult;
    }

    const removeResult = readEnvironmentScope(threadRef.environmentId, AuthSourceControlWriteScope)
      ? await removeWorktree({
          environmentId: threadRef.environmentId,
          input: {
            cwd: threadProject.workspaceRoot,
            path: orphanedWorktreePath,
            force: true,
          },
        })
      : AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              message: m(msg("This connection can no longer remove worktrees.")),
              requiredScope: AuthSourceControlWriteScope,
            }),
          ),
        );
    const refreshResult =
      removeResult._tag === "Success"
        ? await refreshVcsStatus({
            environmentId: threadRef.environmentId,
            input: { cwd: threadProject.workspaceRoot },
          })
        : null;
    const cleanupFailure =
      removeResult._tag === "Failure"
        ? removeResult
        : refreshResult?._tag === "Failure"
          ? refreshResult
          : null;
    if (cleanupFailure) {
      const removalFailed = removeResult._tag === "Failure";
      const error = squashAtomCommandFailure(cleanupFailure);
      const message = thrownErrorMessage(error, m) ?? m(msg("An error occurred."));
      console.error("Worktree cleanup failed after thread deletion", {
        threadId: threadRef.threadId,
        projectCwd: threadProject.workspaceRoot,
        worktreePath: orphanedWorktreePath,
        error,
      });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: removalFailed
            ? m(msg("Failed to delete worktree"))
            : m(msg("Worktree deleted, but Git status refresh failed")),
          description: removalFailed
            ? m(
                msg("Could not remove {path}. {message}", {
                  path: displayWorktreePath ?? orphanedWorktreePath,
                  message,
                }),
              )
            : message,
        }),
      );
      // Cleanup has its own toast; reporting its failure would falsely imply deletion failed.
    }
    return deleteResult;
  };

  const unsettleChat = (target: ScopedThreadRef, restoreUnsettledAt?: string | null) => {
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    return unsettleThreadMutation({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        reason: "user",
        ...(restoreUnsettledAt === undefined ? {} : { restoreUnsettledAt }),
      },
    });
  };

  const unsettleThread = async (target: ScopedThreadRef, restoreUnsettledAt?: string | null) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return firstFailure(
      await Promise.all(
        readTabRefs(target, (chat) => chat.settledOverride === "settled").map((ref) =>
          // Only the target's own earlier state is known to the undo step.
          unsettleChat(ref, ref === target ? restoreUnsettledAt : undefined),
        ),
      ),
    );
  };

  const reorderPinnedChat = (target: ScopedThreadRef, orderKey: string) => {
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    return reorderPinnedThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  const pinChat = (target: ScopedThreadRef, orderKey: string | undefined) => {
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return pinThreadMutation({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        ...(orderKey !== undefined ? { orderKey } : {}),
      },
    });
  };

  const sendPin = async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const tabs = readTabRefs(target, () => true).map((ref) => ({
      ref,
      thread: readThreadShell(ref),
    }));
    // Without an explicit slot the strip keeps the one a pinned tab already holds.
    const orderKey =
      opts.orderKey ??
      tabs.find(({ thread }) => thread?.pinnedAt != null && thread.pinOrderKey != null)?.thread
        ?.pinOrderKey ??
      topOfPinnedRunOrderKey();
    return firstFailure(
      await Promise.all(
        tabs.map(({ ref, thread }) =>
          // Pinning a pinned thread keeps its key, so the strip's other pinned tabs move by
          // reorder. The target itself is pinned outright: an undo may see its stale pin.
          ref !== target &&
          thread?.pinnedAt != null &&
          orderKey !== undefined &&
          thread.pinOrderKey !== orderKey
            ? reorderPinnedChat(ref, orderKey)
            : pinChat(ref, orderKey),
        ),
      ),
    );
  };

  const pinThread = async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
    const result = await sendPin(target, opts);
    if (result._tag === "Success") announce(m(msg("Pinned 1 thread")));
    return result;
  };

  const unpinThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    // A strip stays pinned while any tab is, so every pinned tab has to go.
    const before = readTabRefs(target, (chat) => chat.pinnedAt != null).map((ref) => ({
      ref,
      plan: ThreadUndo.planThreadUndo("unpin", readThreadShell(ref)),
    }));
    const action = claimTabs(
      "pin",
      before.map(({ ref }) => ref),
    );
    const results = await Promise.all(
      before.map(({ ref }) =>
        unpinThreadMutation({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        }),
      ),
    );
    const result = firstFailure(results);
    const unpinned = before.filter((_, index) => results[index]!._tag === "Success");
    if (unpinned.length > 0 && action.isCurrent()) {
      showThreadUndoNotice({
        action: "Unpinned",
        claim: action,
        // One Undo pins every tab it unpinned back into its own slot.
        undo: async () =>
          firstFailure(
            await Promise.all(
              unpinned.map(({ ref, plan }) =>
                ThreadUndo.executeThreadUndo(
                  plan,
                  (step) =>
                    step.action === "pin"
                      ? pinChat(ref, pinOrderKeyFor(ref, step.orderKey))
                      : runUndoPlan(ref, [step], true),
                  (restored) => restored._tag === "Success",
                ),
              ),
            ),
          ),
        failureTitle: m(msg("Failed to undo unpin")),
      });
    } else {
      action.finish();
    }
    return result;
  };

  const settleThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    // Tabs settled earlier stay out of this Undo.
    const targets = readTabRefs(target, (chat) => chat.settledOverride !== "settled");
    const now = new Date().toISOString();
    const before = targets.map((ref) => {
      const thread = readThreadShell(ref);
      return {
        ref,
        wokeAt: thread ? threadWokeAt(thread, { now }) : null,
        // Settling also drops the pin and the snooze server-side, so Undo
        // has to put those back as well.
        undoPlan: ThreadUndo.planThreadUndo("settle", thread),
      };
    });
    // An older unpin/snooze Undo would re-pin or re-snooze, and the server
    // treats either as a promotion that un-settles; settling supersedes them.
    for (const ref of targets) {
      ThreadUndo.invalidate("pin", scopedThreadKey(ref));
      ThreadUndo.invalidate("snooze", scopedThreadKey(ref));
    }
    const action = claimTabs("settle", targets);
    const results = await Promise.all(
      targets.map((ref) =>
        settleThreadMutation({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        }),
      ),
    );
    const settled = before.filter((_, index) => results[index]!._tag === "Success");
    if (settled.length === 0) {
      action.finish();
      return firstFailure(results);
    }
    for (const { ref, wokeAt } of settled) {
      if (wokeAt !== null) markThreadVisited(scopedThreadKey(ref), wokeAt);
    }
    showThreadUndoNotice({
      action: "Settled",
      claim: action,
      undo: async () =>
        firstFailure(
          await Promise.all(settled.map(({ ref, undoPlan }) => runUndoPlan(ref, undoPlan, true))),
        ),
      failureTitle: m(msg("Failed to undo settle")),
    });
    return firstFailure(results);
  };

  const confirmAndUnpinThread = async (target: ScopedThreadRef) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTarget(target);
    const confirmationResult = await requestThreadUnpinConfirmation({
      enabled: confirmThreadUnpin,
      title: resolved?.thread.title ?? null,
      confirm: localApi ? (message) => localApi.dialogs.confirm(message) : null,
    });
    if (confirmationResult._tag === "Failure") {
      return confirmationResult;
    }
    if (!confirmationResult.value) {
      return AsyncResult.success(undefined);
    }
    return unpinThread(target);
  };

  const reorderPinnedThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return moveTabs(target, (ref) => reorderPinnedChat(ref, orderKey));
  };

  const reorderActiveThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadActiveReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return moveTabs(target, (ref) =>
      reorderActiveThreadMutation({
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId, orderKey },
      }),
    );
  };

  const unsnoozeChat = (target: ScopedThreadRef) => {
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return unsnoozeThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  };

  const unsnoozeThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const now = new Date().toISOString();
    return firstFailure(
      await Promise.all(
        readTabRefs(target, (chat) => effectiveSnoozed(chat, { now })).map(unsnoozeChat),
      ),
    );
  };

  const snoozeThread = async (target: ScopedThreadRef, snoozedUntil: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const now = new Date().toISOString();
    // Settled tabs stay settled, and tabs already asleep keep their own wake time.
    const targets = readTabRefs(
      target,
      (chat) => chat.settledOverride !== "settled" && !effectiveSnoozed(chat, { now }),
    );
    const blocked = targets.find((ref) => {
      const thread = readThreadShell(ref);
      return thread !== null && !canSnooze(thread, { now });
    });
    if (blocked) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeBlockedError({
            environmentId: blocked.environmentId,
            threadId: blocked.threadId,
          }),
        ),
      );
    }
    const action = claimTabs("snooze", targets);
    const results = await Promise.all(
      targets.map((ref) =>
        snoozeThreadMutation({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, snoozedUntil },
        }),
      ),
    );
    const snoozed = targets.filter((_, index) => results[index]!._tag === "Success");
    if (snoozed.length === 0) {
      action.finish();
      return firstFailure(results);
    }
    showThreadUndoNotice({
      action: "Snoozed",
      claim: action,
      undo: async () =>
        firstFailure(
          await Promise.all(
            snoozed.map((ref) => runUndoPlan(ref, ThreadUndo.planThreadUndo("snooze"), true)),
          ),
        ),
      failureTitle: m(msg("Failed to wake thread")),
    });
    return firstFailure(results);
  };

  // A tab-strip Undo restores each chat it moved, so its steps act on that chat alone.
  const runUndoPlan = (
    target: ScopedThreadRef,
    plan: ThreadUndo.ThreadUndoPlan,
    chatOnly = false,
  ) => {
    let cancelledOnDevice = false;
    return ThreadUndo.executeThreadUndo(
      plan,
      async (step) => {
        if (
          cancelledOnDevice &&
          !ThreadUndo.restoresAfterDeviceCancel(step, readThreadShell(target))
        ) {
          return AsyncResult.success(undefined);
        }
        switch (step.action) {
          case "unsettle": {
            const result = await (chatOnly
              ? unsettleChat(target, step.restoreUnsettledAt)
              : unsettleThread(target, step.restoreUnsettledAt));
            cancelledOnDevice =
              result._tag === "Success" && ThreadUndo.cancelledOnDevice(result.value);
            return result;
          }
          case "unsnooze":
            return chatOnly ? unsnoozeChat(target) : unsnoozeThread(target);
          case "pin":
            return sendPin(target, step.orderKey === undefined ? {} : { orderKey: step.orderKey });
          case "reorderActive":
            return reorderActiveThread(target, step.orderKey);
          case "snooze":
            return snoozeThreadMutation({
              environmentId: target.environmentId,
              input: { threadId: target.threadId, snoozedUntil: step.snoozedUntil },
            });
        }
      },
      (result) => result._tag === "Success",
    );
  };

  const confirmAndDeleteThread = async (target: ScopedThreadRef, knownTitle?: string) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTarget(target);

    if (confirmThreadDelete && localApi) {
      const title = resolved?.thread.title ?? knownTitle ?? null;
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [
            title === null
              ? m(msg('Delete thread "this thread"?'))
              : m(msg('Delete thread "{title}"?', { title })),
            m(msg("This permanently clears conversation history for this thread.")),
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      if (!confirmationResult.value) {
        return AsyncResult.success(undefined);
      }
    }

    return deleteThread(target);
  };

  return {
    archiveThread,
    unarchiveThread,
    deleteThread,
    confirmAndDeleteThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    reorderPinnedThread,
    reorderActiveThread,
    markThreadUnread,
    turnThreadIntoProject: (target: ScopedThreadRef) =>
      createProjectFromThread({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      }),
  };
}

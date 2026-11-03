/**
 * Fork: when limit failover continues the open thread in a new tab
 * (`limitRecovery.continuedIn`), take the user there with any unsent draft.
 * Reopening a thread that already moved on stays put.
 */
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { waitForThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";

export function useFollowLimitFailover(
  threadRef: ScopedThreadRef,
  /** The open thread's shell, or null while it loads. */
  shell: Pick<EnvironmentThreadShell, "id" | "limitRecovery"> | null | undefined,
) {
  const navigate = useNavigate();
  const threadKey = scopedThreadKey(threadRef);
  const loaded = shell?.id === threadRef.threadId;
  const continuedIn = shell?.limitRecovery?.continuedIn;
  const observedRef = useRef<{ threadKey: string; continuedIn: ThreadId | undefined } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows a limit failover that the server reports after the thread opened
  useEffect(() => {
    if (!loaded) return;
    const observed = observedRef.current;
    observedRef.current = { threadKey, continuedIn };
    if (continuedIn === undefined || observed?.threadKey !== threadKey || observed.continuedIn)
      return;
    const targetThreadRef = scopeThreadRef(threadRef.environmentId, continuedIn);
    void (async () => {
      if (!(await waitForThreadShell(targetThreadRef))) return;
      if (observedRef.current?.threadKey !== threadKey) return;
      useComposerDraftStore.getState().moveComposerPromptAndImages(threadRef, targetThreadRef);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(targetThreadRef),
      });
    })();
  }, [continuedIn, loaded, navigate, threadKey, threadRef]);
}

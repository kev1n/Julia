/**
 * Fork (Owner): a quiet notice when another live chat, on any of Owner's
 * machines, has potentially conflicting goals or shared findings. Neither agent is messaged;
 * "Review with agent" only fills this chat's composer for the user to send.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  fleetOverlapReasons,
  fleetOverlapPrompt,
  fleetOverlapSignature,
  fleetOverlapTitle,
} from "@t3tools/client-runtime/fleet-overlaps";
import type { ForkFleetOverlapsResult, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { UsersIcon } from "lucide-react";
import { useState } from "react";

import type { ComposerBannerStackItem } from "../../components/chat/ComposerBannerStack";
import { InlineButton } from "../../components/ui/button";
import { useComposerDraftStore } from "../../composerDraftStore";
import { serverEnvironment } from "../../state/server";

const NO_THREAD = Atom.make(AsyncResult.initial<ForkFleetOverlapsResult, never>());
// Dismissed signatures per thread, for this window's lifetime.
const dismissed = new Map<string, string>();

export function useFleetOverlapBanner(
  threadRef: ScopedThreadRef | null,
): ComposerBannerStackItem | null {
  const [dismissals, setDismissals] = useState(() => new Map(dismissed));
  const result = useAtomValue(
    threadRef === null
      ? NO_THREAD
      : serverEnvironment.fleetOverlaps({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  if (threadRef === null) return null;
  const overlaps = Option.getOrNull(AsyncResult.value(result))?.overlaps ?? [];
  const [first] = overlaps;
  if (first === undefined) return null;
  const key = `${threadRef.environmentId}/${threadRef.threadId}`;
  const signature = fleetOverlapSignature(overlaps);
  if (dismissals.get(key) === signature) return null;
  return {
    id: "fork-fleet-overlap",
    variant: "info",
    priority: "notice",
    icon: <UsersIcon />,
    title: fleetOverlapTitle(overlaps),
    description: fleetOverlapReasons(overlaps),
    actions: (
      <>
        <InlineButton render={<a href={first.url} target="_blank" rel="noreferrer" />}>
          Open related chat
        </InlineButton>
        <InlineButton
          onClick={() => {
            const store = useComposerDraftStore.getState();
            const current = store.getComposerDraft(threadRef)?.prompt.trim() ?? "";
            const prompt = fleetOverlapPrompt(overlaps);
            store.setPrompt(threadRef, current === "" ? prompt : `${current}\n\n${prompt}`);
          }}
        >
          Review with agent
        </InlineButton>
      </>
    ),
    dismissLabel: "Dismiss until the overlap changes",
    onDismiss: () => {
      dismissed.set(key, signature);
      setDismissals(new Map(dismissed));
    },
  };
}

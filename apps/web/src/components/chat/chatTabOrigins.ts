import type { RunId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";

/** The chat a new tab was opened from, captured while that chat could still fork. */
export interface ChatTabOrigin {
  readonly threadRef: ScopedThreadRef;
  readonly runId: RunId;
  readonly title: string;
  readonly chatGroupId: ThreadId | null;
}

/** New-tab drafts offer to bring in the context of the chat they were opened
 * from. Kept in memory: after a reload the draft is just a fresh chat. */
export const useChatTabOriginStore = create<{
  readonly byDraftId: Readonly<Record<string, ChatTabOrigin>>;
}>(() => ({ byDraftId: {} }));

export function setChatTabOrigin(draftId: DraftId, origin: ChatTabOrigin | null): void {
  useChatTabOriginStore.setState(({ byDraftId }) => {
    const { [draftId]: _previous, ...rest } = byDraftId;
    return { byDraftId: origin === null ? rest : { ...rest, [draftId]: origin } };
  });
}

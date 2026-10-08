import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

type MessageHistoryItem = Pick<
  OrchestrationV2TurnItem,
  "id" | "threadId" | "runId" | "type" | "status" | "parentItemId"
> & { readonly streaming?: boolean };

/** Keep the complete response after the last work activity, not just its last chunk.
 * Trailing activity (such as checkpointing) does not discard an already-finished answer.
 */
export function selectFinalMessageHistory<T extends MessageHistoryItem>(items: readonly T[]): T[] {
  const replies = new Set<T["id"]>();
  const finishedTurns = new Set<string>();
  const blockedTurns = new Set<string>();
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item || item.parentItemId !== null) continue;
    const turnKey = `${item.threadId}:${item.runId ?? item.id}`;
    if (blockedTurns.has(turnKey)) continue;
    if (item.type === "assistant_message" || item.type === "proposed_plan") {
      if (item.status === "completed" && item.streaming !== true) {
        finishedTurns.add(turnKey);
        replies.add(item.id);
      }
    } else if (item.type !== "user_message" && finishedTurns.has(turnKey)) {
      blockedTurns.add(turnKey);
    }
  }
  return items.filter((item) => item.type === "user_message" || replies.has(item.id));
}

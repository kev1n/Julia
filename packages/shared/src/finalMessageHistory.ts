import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

type MessageHistoryItem = Pick<
  OrchestrationV2TurnItem,
  "id" | "threadId" | "runId" | "type" | "status" | "parentItemId"
> & { readonly streaming?: boolean };

/** Keep user inputs and the last finished root reply in each turn, in timeline order. */
export function selectFinalMessageHistory<T extends MessageHistoryItem>(items: readonly T[]): T[] {
  const replies = new Map<string, T["id"]>();
  for (const item of items) {
    if (
      item.type !== "assistant_message" ||
      item.status !== "completed" ||
      item.streaming === true ||
      item.parentItemId !== null
    )
      continue;
    // Imported runless conversations already contain individual final replies.
    const turnKey = `${item.threadId}:${item.runId ?? item.id}`;
    replies.set(turnKey, item.id);
  }
  return items.filter(
    (item) =>
      item.type === "user_message" ||
      replies.get(`${item.threadId}:${item.runId ?? item.id}`) === item.id,
  );
}

import { describe, expect, it } from "vite-plus/test";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { selectFinalMessageHistory } from "./finalMessageHistory.ts";

describe("compact fork history", () => {
  it("keeps inputs and only the last completed root reply per source turn", () => {
    const base = {
      threadId: ThreadId.make("ancestor"),
      runId: RunId.make("turn"),
      parentItemId: null,
      status: "completed" as const,
      streaming: false,
    };
    const items = [
      { ...base, id: TurnItemId.make("user"), type: "user_message" as const },
      { ...base, id: TurnItemId.make("commentary"), type: "assistant_message" as const },
      { ...base, id: TurnItemId.make("tool"), type: "dynamic_tool" as const },
      { ...base, id: TurnItemId.make("final"), type: "assistant_message" as const },
      {
        ...base,
        id: TurnItemId.make("child"),
        type: "assistant_message" as const,
        parentItemId: TurnItemId.make("tool"),
      },
      {
        ...base,
        id: TurnItemId.make("unfinished"),
        type: "assistant_message" as const,
        streaming: true,
      },
      {
        ...base,
        threadId: ThreadId.make("fork"),
        id: TurnItemId.make("fork-final"),
        type: "assistant_message" as const,
      },
    ];
    expect(selectFinalMessageHistory(items).map((item) => item.id)).toEqual([
      "user",
      "final",
      "fork-final",
    ]);
  });

  it("preserves individual replies in imported runless history", () => {
    const items = ["legacy-1", "legacy-2"].map((id) => ({
      id: TurnItemId.make(id),
      threadId: ThreadId.make("legacy"),
      runId: null,
      parentItemId: null,
      status: "completed" as const,
      type: "assistant_message" as const,
    }));
    expect(selectFinalMessageHistory(items)).toEqual(items);
  });
});

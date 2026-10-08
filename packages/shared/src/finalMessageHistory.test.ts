import { describe, expect, it } from "vite-plus/test";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { selectFinalMessageHistory } from "./finalMessageHistory.ts";

describe("compact fork history", () => {
  it("keeps every completed response chunk after work, across fork ancestry", () => {
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
      { ...base, id: TurnItemId.make("heading-and-table"), type: "assistant_message" as const },
      { ...base, id: TurnItemId.make("final"), type: "assistant_message" as const },
      { ...base, id: TurnItemId.make("trailing-reasoning"), type: "reasoning" as const },
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
      "heading-and-table",
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

it("keeps all replies when a turn has no work, and excludes nested or unfinished output", () => {
  const base = {
    threadId: ThreadId.make("thread"),
    runId: RunId.make("run"),
    parentItemId: null,
    status: "completed" as const,
    streaming: false,
  };
  const items = [
    { ...base, id: TurnItemId.make("prompt"), type: "user_message" as const },
    { ...base, id: TurnItemId.make("heading"), type: "assistant_message" as const },
    { ...base, id: TurnItemId.make("table"), type: "assistant_message" as const },
    { ...base, id: TurnItemId.make("plan"), type: "proposed_plan" as const },
    {
      ...base,
      id: TurnItemId.make("unfinished"),
      type: "assistant_message" as const,
      streaming: true,
    },
  ];
  expect(selectFinalMessageHistory(items).map((item) => item.id)).toEqual([
    "prompt",
    "heading",
    "table",
    "plan",
  ]);
});

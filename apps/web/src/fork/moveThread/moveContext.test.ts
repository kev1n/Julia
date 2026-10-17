import { describe, expect, it } from "vite-plus/test";

import { buildMoveMessage, selectMoveHistory, type MoveContextMessage } from "./moveContext";

const message = (role: MoveContextMessage["role"], text: string): MoveContextMessage => ({
  role,
  text,
});

describe("selectMoveHistory", () => {
  it("keeps the original request and the most recent messages that fit, in order", () => {
    const messages = [
      message("user", "original request"),
      message("assistant", "a".repeat(400)),
      message("user", "b".repeat(400)),
      message("assistant", "recent answer"),
      message("user", "latest request"),
    ];
    const { indexes, omitted } = selectMoveHistory(messages, 520);
    expect(indexes).toEqual([0, 2, 3, 4]);
    expect(omitted).toBe(1);
  });

  it("skips system and empty messages", () => {
    const { indexes } = selectMoveHistory(
      [message("system", "x"), message("user", "hi"), message("assistant", "  ")],
      1_000,
    );
    expect(indexes).toEqual([1]);
  });
});

describe("buildMoveMessage", () => {
  it("says where the thread came from, which branch holds the work, and carries the history", () => {
    const text = buildMoveMessage({
      title: "Fix login",
      fromMachine: "Laptop",
      toMachine: "Build Mac",
      branch: "t3/fix-login",
      messages: [message("user", "Remember the word lantern."), message("assistant", "Noted.")],
    });
    expect(text).toContain("moved here from Laptop to Build Mac");
    expect(text).toContain("branch t3/fix-login");
    expect(text).toContain("[user]\nRemember the word lantern.\n\n[assistant]\nNoted.");
    expect(text).not.toContain("omitted");
  });
});

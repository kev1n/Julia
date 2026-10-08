import { describe, expect, it } from "vite-plus/test";
import {
  fleetOverlapPrompt,
  fleetOverlapReasons,
  fleetOverlapSignature,
  fleetOverlapTitle,
} from "./fleetOverlaps.ts";
const overlap = (threadId: string, reason = "Both chats investigate dropped messages.") => ({
  environmentId: "env-mac-a",
  threadId,
  title: `Chat ${threadId}`,
  machine: "mac-a",
  lifecycle: "running" as const,
  branch: null,
  url: "https://mac-a/env-mac-a/thread",
  kind: "duplicate_investigation" as const,
  reason,
});
describe("fleet coordination suggestions", () => {
  it("explains the semantic relationship without claiming shared files", () => {
    expect(fleetOverlapTitle([overlap("a")])).toBe(
      '"Chat a" on mac-a may be investigating the same bug',
    );
    expect(fleetOverlapTitle([{ ...overlap("a"), kind: "conflicting_intent" }])).toContain(
      "may be working against this chat",
    );
    expect(fleetOverlapReasons([overlap("a")])).toBe("Both chats investigate dropped messages.");
  });
  it("dismisses by relationship and identity, independent of wording, ordering and lifecycle", () => {
    const before = fleetOverlapSignature([overlap("a"), overlap("b")]);
    expect(fleetOverlapSignature([overlap("b"), { ...overlap("a"), lifecycle: "idle" }])).toBe(
      before,
    );
    expect(fleetOverlapSignature([overlap("a", "Different wording"), overlap("b")])).toBe(before);
    expect(
      fleetOverlapSignature([{ ...overlap("a"), kind: "conflicting_intent" }, overlap("b")]),
    ).not.toBe(before);
  });
  it("drafts a review request without authorizing automatic forwarding", () => {
    const prompt = fleetOverlapPrompt([overlap("a")]);
    expect(prompt).toContain("environmentId env-mac-a, threadId a");
    expect(prompt).toContain("Both chats investigate dropped messages.");
    expect(prompt).toContain("Do not message another chat unless I ask you to.");
  });
});

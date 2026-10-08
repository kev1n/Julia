import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { deriveThreadContextWindowSnapshot, formatContextWindowReadout } from "./contextWindow.ts";

function projection() {
  return {
    thread: { activeProviderThreadId: "active" },
    providerThreads: [
      {
        id: "active",
        nativeThreadRef: { nativeId: "native-current" },
        nativeMetadata: { modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } },
        contextUsage: { usedTokens: 20_000, maxTokens: 200_000 },
        updatedAt: DateTime.makeUnsafe("2026-10-07T00:00:00.000Z"),
      },
    ],
    providerTurns: [
      {
        providerThreadId: "active",
        runAttemptId: "attempt",
        nodeId: "root",
        tokenUsage: {
          usedTokens: 130_200,
          maxTokens: 258_400,
          updatedAt: "2026-10-07T00:01:00.000Z",
        },
      },
    ],
    attempts: [
      { id: "attempt", runId: "run", rootNodeId: "root", nativeThreadId: "native-current" },
    ],
    runs: [{ id: "run", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }],
    visibleTurnItems: [],
  };
}

const snapshot = (value: ReturnType<typeof projection>) =>
  deriveThreadContextWindowSnapshot(value as unknown as OrchestrationV2ThreadProjection);

describe("current thread context", () => {
  it("keeps the latest root report visible between turns", () => {
    expect(formatContextWindowReadout(snapshot(projection()))).toBe(
      "Context 130.2k/258.4k · 50.4%",
    );
  });

  it("does not show another provider thread's latest usage", () => {
    const value = projection();
    value.providerTurns.push({ ...value.providerTurns[0]!, providerThreadId: "old" });
    expect(snapshot(value)?.usedTokens).toBe(130_200);
    value.providerTurns.shift();
    expect(snapshot(value)?.usedTokens).toBe(20_000);
  });

  it("does not revive telemetry after the native session has been replaced", () => {
    const value = projection();
    value.providerThreads[0]!.nativeThreadRef.nativeId = "native-replacement";
    expect(snapshot(value)?.usedTokens).toBe(20_000);
  });

  it("does not use a child agent's context as the main thread's", () => {
    const value = projection();
    value.providerTurns[0]!.nodeId = "child";
    expect(snapshot(value)?.usedTokens).toBe(20_000);
  });

  it("uses the provider's revised window after a model switch", () => {
    const value = projection();
    value.providerThreads[0]!.nativeMetadata.modelSelection.model = "another-model";
    expect(snapshot(value)?.maxTokens).toBe(200_000);
  });

  it("reports unavailable instead of zero when the active session has no report", () => {
    const value = projection();
    value.providerThreads = [];
    expect(formatContextWindowReadout(snapshot(value))).toBe("Context unavailable");
    expect(formatContextWindowReadout(deriveThreadContextWindowSnapshot(null))).toBe(
      "Context unavailable",
    );
  });
});

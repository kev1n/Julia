import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { autofixModelSelection } from "./autofixAccount.ts";

const NOW = Date.parse("2026-10-08T05:00:00Z");
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

function account(instanceId: string, driver: string, weeklyUsed: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(NOW),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(NOW),
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: weeklyUsed,
          resetsAt: iso(NOW + 3 * 86_400_000),
        },
      ],
    },
  };
}

describe("autofixModelSelection", () => {
  it("moves off a Claude account whose week is used up to one with usage left", () => {
    const providers = [
      account("claudeAgent", "claudeAgent", 100),
      account("claude_alice", "claudeAgent", 30),
      account("codex", "codex", 0),
    ];
    expect(autofixModelSelection(providers, NOW)).toEqual({
      instanceId: "claude_alice",
      model: "claude-opus-5-5",
    });
  });

  it("falls back to GPT-6.1 on the freest Codex account when every Claude account is limited", () => {
    const providers = [
      account("claudeAgent", "claudeAgent", 100),
      account("claude_alice", "claudeAgent", 97),
      account("codex", "codex", 80),
      account("codex_alice", "codex", 10),
    ];
    expect(autofixModelSelection(providers, NOW)).toEqual({
      instanceId: "codex_alice",
      model: "gpt-6.1-sol",
    });
  });

  it("keeps Claude owner when no account has usage left", () => {
    const providers = [account("claudeAgent", "claudeAgent", 100), account("codex", "codex", 100)];
    expect(autofixModelSelection(providers, NOW)).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });
});

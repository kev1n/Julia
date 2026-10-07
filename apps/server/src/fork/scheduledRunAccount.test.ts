import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { scheduledRunModelSelection } from "./scheduledRunAccount.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const later = iso(NOW + 2 * 3_600_000);

function account(
  instanceId: string,
  sessionUsed: number,
  extra: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
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
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: sessionUsed,
          resetsAt: later,
        },
      ],
    },
    ...extra,
  };
}

const saved: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeA"),
  model: "claude-opus-5-5",
};

describe("scheduledRunModelSelection", () => {
  it("keeps the saved account while it has limit left", () => {
    const providers = [account("claudeA", 90), account("claudeB", 0)];
    expect(scheduledRunModelSelection(saved, providers, NOW)).toEqual(saved);
  });

  it("moves a limited account to the one with the most session left, keeping the model", () => {
    const providers = [account("claudeA", 100), account("claudeB", 70), account("claudeC", 20)];
    expect(scheduledRunModelSelection(saved, providers, NOW)).toEqual({
      ...saved,
      instanceId: ProviderInstanceId.make("claudeC"),
    });
  });

  it("moves a signed-out account too", () => {
    const providers = [
      account("claudeA", 0, { auth: { status: "unauthenticated" } }),
      account("claudeB", 50),
    ];
    expect(scheduledRunModelSelection(saved, providers, NOW).instanceId).toBe("claudeB");
  });

  it("never moves to another provider, and keeps the saved account when nothing is left", () => {
    const providers = [
      account("claudeA", 100),
      account("codex", 0, { driver: ProviderDriverKind.make("codex") }),
    ];
    expect(scheduledRunModelSelection(saved, providers, NOW)).toEqual(saved);
  });
});

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withAutoAccount } from "./autoAccount";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const later = new Date(NOW + 2 * 3_600_000).toISOString();

function account(
  instanceId: string,
  sessionUsed: number,
  models = ["claude-opus-5-5"],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(NOW).toISOString(),
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: new Date(NOW).toISOString(),
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
  };
}

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeA"),
  model: "claude-opus-5-5",
};

describe("withAutoAccount", () => {
  it("moves the default to the account with the most session left", () => {
    expect(
      withAutoAccount(selection, [account("claudeA", 100), account("claudeB", 40)], NOW)
        ?.instanceId,
    ).toBe("claudeB");
  });

  it("stays when the best account lacks the model", () => {
    expect(
      withAutoAccount(selection, [account("claudeA", 100), account("claudeB", 0, ["other"])], NOW),
    ).toBe(selection);
  });

  it("falls back to Sol when both Opus accounts are exhausted, without carrying Claude options", () => {
    const codex = {
      ...account("codex", 30, ["gpt-6.1-sol", "gpt-6-astra"]),
      driver: ProviderDriverKind.make("codex"),
    };
    expect(
      withAutoAccount(
        { ...selection, options: [{ id: "effort", value: "max" }] },
        [account("claudeA", 100), account("claudeB", 100), codex],
        NOW,
      ),
    ).toEqual({ instanceId: codex.instanceId, model: "gpt-6.1-sol" });
  });

  it("can use a user-pinned model when the preferred models have no capacity", () => {
    const pinned = {
      ...account("cursor", 0, ["custom"]),
      driver: ProviderDriverKind.make("cursor"),
    };
    expect(
      withAutoAccount(selection, [account("claudeA", 100), pinned], NOW, [
        { provider: pinned.instanceId, model: "custom" },
      ]),
    ).toEqual({ instanceId: pinned.instanceId, model: "custom" });
  });

  it("preserves options when only the account changes", () => {
    const configured = { ...selection, options: [{ id: "effort", value: "high" }] };
    expect(
      withAutoAccount(configured, [account("claudeA", 100), account("claudeB", 40)], NOW),
    ).toEqual({ ...configured, instanceId: ProviderInstanceId.make("claudeB") });
  });

  it("chooses an account that supports the model even if an incompatible account has more capacity", () => {
    expect(
      withAutoAccount(
        selection,
        [account("claudeA", 100), account("claudeB", 0, ["other"]), account("claudeC", 30)],
        NOW,
      )?.instanceId,
    ).toBe("claudeC");
  });
});

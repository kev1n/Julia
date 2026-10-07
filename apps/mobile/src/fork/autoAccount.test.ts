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
});

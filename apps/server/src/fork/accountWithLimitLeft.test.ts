import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { accountWithLimitLeft } from "./accountWithLimitLeft.ts";

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
    models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
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

describe("accountWithLimitLeft", () => {
  it("keeps the saved account while it has limit left", () => {
    const providers = [account("claudeA", 90), account("claudeB", 0)];
    expect(accountWithLimitLeft(saved, providers, NOW)).toEqual(saved);
  });

  it("moves a limited account to the one with the most session left, keeping the model", () => {
    const providers = [account("claudeA", 100), account("claudeB", 70), account("claudeC", 20)];
    expect(accountWithLimitLeft(saved, providers, NOW)).toEqual({
      ...saved,
      instanceId: ProviderInstanceId.make("claudeC"),
    });
  });

  it("moves a signed-out account too", () => {
    const providers = [
      account("claudeA", 0, { auth: { status: "unauthenticated" } }),
      account("claudeB", 50),
    ];
    expect(accountWithLimitLeft(saved, providers, NOW).instanceId).toBe("claudeB");
  });

  it("never moves to another provider, and keeps the saved account when nothing is left", () => {
    const providers = [
      account("claudeA", 100),
      account("codex", 0, { driver: ProviderDriverKind.make("codex") }),
    ];
    expect(accountWithLimitLeft(saved, providers, NOW)).toEqual(saved);
  });
  it("ignores an exhausted quota for another model but honors global and matching quotas", () => {
    const scoped = account("claudeA", 10);
    const providers = [
      {
        ...scoped,
        usageLimits: {
          ...scoped.usageLimits!,
          windows: [
            ...scoped.usageLimits!.windows,
            {
              id: "seven_day_fable",
              kind: "weekly" as const,
              label: "Fable",
              usedPercent: 100,
              modelScope: "claude-fable",
            },
          ],
        },
      },
      account("claudeB", 0),
    ];
    expect(accountWithLimitLeft(saved, providers, NOW)).toEqual(saved);
    const matching = {
      ...providers[0]!,
      usageLimits: {
        ...providers[0]!.usageLimits!,
        windows: providers[0]!.usageLimits!.windows.map((window) =>
          window.modelScope ? { ...window, modelScope: "claude-opus" } : window,
        ),
      },
    };
    expect(accountWithLimitLeft(saved, [matching, providers[1]!], NOW).instanceId).toBe("claudeB");
  });

  it("skips accounts without the model or a registered adapter", () => {
    const providers = [
      account("claudeA", 100),
      account("no-model", 0, { models: [] }),
      account("no-adapter", 0),
      account("claudeB", 40),
    ];
    expect(
      accountWithLimitLeft(saved, providers, NOW, {
        eligibleInstanceIds: new Set(
          providers
            .filter((item) => item.instanceId !== "no-adapter")
            .map((item) => item.instanceId),
        ),
      }).instanceId,
    ).toBe("claudeB");
  });

  it("requires the replacement to support every selected option", () => {
    const selection = { ...saved, options: [{ id: "effort", value: "high" }] };
    const providers = [account("claudeA", 100), account("claudeB", 0)];
    expect(accountWithLimitLeft(selection, providers, NOW)).toEqual(selection);
    const compatible = account("claudeC", 20, {
      models: [
        {
          slug: saved.model,
          name: "Opus",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    });
    expect(accountWithLimitLeft(selection, [...providers, compatible], NOW)).toEqual({
      ...selection,
      instanceId: compatible.instanceId,
    });
  });

  it("excludes failed accounts even when their usage snapshots are still healthy", () => {
    const providers = [account("claudeA", 0), account("claudeB", 0), account("claudeC", 40)];
    expect(
      accountWithLimitLeft(saved, providers, NOW, {
        force: true,
        excludedInstanceIds: new Set([providers[0]!.instanceId, providers[1]!.instanceId]),
      }).instanceId,
    ).toBe("claudeC");
  });
});

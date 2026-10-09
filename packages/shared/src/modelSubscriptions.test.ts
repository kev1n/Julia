import { ProviderInstanceId, type ServerProviderUsageLimits } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  chooseNewChatModelSubscription,
  defaultModelPriority,
  groupModelSubscriptions,
  type ModelSubscription,
} from "./modelSubscriptions.ts";

const now = Date.parse("2026-10-07T12:00:00Z");
function subscription(
  id: string,
  sessionUsed: number | null,
  weeklyUsed = 0,
): ModelSubscription<string> {
  const usageLimits: ServerProviderUsageLimits | undefined =
    sessionUsed === null
      ? undefined
      : {
          checkedAt: "2026-10-07T12:00:00Z",
          windows: [
            { id: "session", kind: "session", label: "Session", usedPercent: sessionUsed },
            { id: "week", kind: "weekly", label: "Week", usedPercent: weeklyUsed },
          ],
        };
  return {
    instanceId: ProviderInstanceId.make(id),
    catalog: "codex",
    model: "gpt-sol",
    available: true,
    usageLimits,
    value: id,
  };
}

describe("groupModelSubscriptions", () => {
  it("does not exhaust Opus recommendations because another model's weekly limit is exhausted", () => {
    const account = {
      ...subscription("scoped", 0),
      model: "claude-opus-5-5",
      usageLimits: {
        checkedAt: "2026-10-07T12:00:00Z",
        windows: [
          {
            id: "seven_day_fable",
            kind: "weekly" as const,
            label: "Fable",
            usedPercent: 100,
            modelScope: "claude-fable",
          },
        ],
      },
    };
    expect(groupModelSubscriptions([account], now)[0]?.recommended?.value).toBe("scoped");
    expect(
      groupModelSubscriptions([{ ...account, model: "claude-fable-5" }], now)[0]?.recommended,
    ).toBeNull();
  });
  it("lists each model once and recommends capacity across every compatible account", () => {
    const groups = groupModelSubscriptions(
      [
        subscription("fresh-session-exhausted-week", 0, 99),
        subscription("unknown", null),
        subscription("room", 40, 30),
        { ...subscription("other-model", 0), model: "gpt-astra" },
      ],
      now,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.recommended?.value).toBe("room");
    expect(groups[0]?.subscriptions.map((item) => item.value)).toEqual([
      "room",
      "fresh-session-exhausted-week",
      "unknown",
    ]);
  });

  it("does not recommend a subscription which cannot serve this model", () => {
    const [group] = groupModelSubscriptions(
      [{ ...subscription("blocked", 0), available: false }, subscription("allowed", 80)],
      now,
    );
    expect(group?.recommended?.value).toBe("allowed");
  });

  it("keeps exhausted accounts available for explicit override without claiming capacity", () => {
    const [group] = groupModelSubscriptions([subscription("limited", 100)], now);
    expect(group?.recommended).toBeNull();
    expect(group?.subscriptions[0]?.available).toBe(true);
  });

  it("keeps catalogs separate even when model slugs and labels match", () => {
    const groups = groupModelSubscriptions(
      [
        subscription("codex", 10),
        { ...subscription("cursor", 10), catalog: "cursor" },
        { ...subscription("registry-a", 10), catalog: "registry:a" },
        { ...subscription("registry-b", 10), catalog: "registry:b" },
      ],
      now,
    );
    expect(groups).toHaveLength(4);
  });

  it("recommends an account again when its exhausted window resets", () => {
    const reset = subscription("reset", 100);
    const [group] = groupModelSubscriptions(
      [
        {
          ...reset,
          usageLimits: {
            ...reset.usageLimits!,
            windows: reset.usageLimits!.windows.map((window) => ({
              ...window,
              resetsAt: "2026-10-07T11:59:00Z",
            })),
          },
        },
        subscription("busy", 80),
      ],
      now,
    );
    expect(group?.recommended?.value).toBe("reset");
  });

  it("falls back to unknown usage without fabricating a remaining percentage", () => {
    const [group] = groupModelSubscriptions(
      [subscription("limited", 100), subscription("unknown", null)],
      now,
    );
    expect(group?.recommended?.value).toBe("unknown");
    expect(group?.recommended?.usageLimits).toBeUndefined();
  });
});

describe("defaultModelPriority", () => {
  it("orders Opus, Sol, then Astra regardless of provider catalog order", () => {
    const models = [
      { catalog: "codex", model: "gpt-6-astra" },
      { catalog: "claudeAgent", model: "claude-sonnet-5-5" },
      { catalog: "codex", model: "gpt-6.1-sol" },
      { catalog: "claudeAgent", model: "claude-opus-5-5" },
    ];
    expect(
      models
        .toSorted(
          (a, b) =>
            defaultModelPriority(a.catalog, a.model) - defaultModelPriority(b.catalog, b.model),
        )
        .map(({ model }) => model),
    ).toEqual(["claude-opus-5-5", "gpt-6.1-sol", "gpt-6-astra", "claude-sonnet-5-5"]);
  });
  it("does not pin a same-named model from a different catalog", () => {
    expect(defaultModelPriority("acpRegistry:custom", "claude-opus-5-5")).toBe(3);
    expect(defaultModelPriority("cursor", "gpt-6.1-sol")).toBe(3);
  });
});

describe("chooseNewChatModelSubscription", () => {
  const opus = (id: string, used: number) => ({
    ...subscription(id, used),
    catalog: "claudeAgent",
    model: "claude-opus-5-5",
  });
  const sol = (id: string, used: number) => ({
    ...subscription(id, used),
    model: "gpt-6.1-sol",
  });
  const selection = { instanceId: ProviderInstanceId.make("claudeA"), model: "claude-opus-5-5" };

  it("falls through two exhausted Opus accounts to Sol, independent of catalog order", () => {
    const choice = chooseNewChatModelSubscription(
      selection,
      [
        opus("claudeA", 100),
        opus("claudeB", 100),
        { ...sol("astra", 0), model: "gpt-6-astra" },
        sol("sol-busy", 80),
        sol("sol-room", 20),
      ],
      [],
      now,
    );
    expect(choice?.model).toBe("gpt-6.1-sol");
    expect(choice?.value).toBe("sol-room");
  });

  it("keeps Opus when a compatible account still has capacity", () => {
    expect(
      chooseNewChatModelSubscription(
        selection,
        [opus("claudeA", 100), opus("claudeB", 80), sol("sol", 0)],
        [],
        now,
      )?.value,
    ).toBe("claudeB");
  });

  it("skips exhausted and unavailable preferred models, then tries user pins in order", () => {
    const subscriptions = [
      opus("claudeA", 100),
      sol("sol", 100),
      { ...sol("astra", 0), model: "gpt-6-astra", available: false },
      { ...subscription("unpinned", 0), model: "other" },
      { ...subscription("pin-second", 0), model: "custom-b" },
      { ...subscription("pin-first", 30), model: "custom-a" },
    ];
    expect(
      chooseNewChatModelSubscription(
        selection,
        subscriptions,
        [
          { provider: ProviderInstanceId.make("pin-first"), model: "custom-a" },
          { provider: ProviderInstanceId.make("pin-second"), model: "custom-b" },
        ],
        now,
      )?.value,
    ).toBe("pin-first");
  });

  it("uses compatible accounts for a user pin, not just the account that was starred", () => {
    expect(
      chooseNewChatModelSubscription(
        selection,
        [
          opus("claudeA", 100),
          { ...subscription("pinned-exhausted", 100), model: "custom" },
          { ...subscription("pinned-room", 40), model: "custom" },
        ],
        [{ provider: ProviderInstanceId.make("pinned-exhausted"), model: "custom" }],
        now,
      )?.value,
    ).toBe("pinned-room");
  });

  it("does not choose an arbitrary unpinned model when all preferred models are exhausted", () => {
    expect(
      chooseNewChatModelSubscription(
        selection,
        [opus("claudeA", 100), sol("sol", 100), subscription("unpinned", 0)],
        [],
        now,
      ),
    ).toBeNull();
  });

  it("does not reinterpret a selection before its catalog has loaded", () => {
    expect(chooseNewChatModelSubscription(selection, [sol("sol", 0)], [], now)).toBeNull();
  });
});

import { EnvironmentId, type ServerProviderUsageWindow } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { shortPlanLabel } from "../autoPlacement/planLabel";
import { buildAccountCards } from "./accountCards";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function account(
  driver: "claudeAgent" | "codex",
  email: string,
  plan: string,
  sessionUsed: number,
  sessionResetHours: number,
  weeklyUsed: number,
): LimitAccount {
  const windows: ServerProviderUsageWindow[] = [
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyUsed,
      resetsAt: inHours(100),
    },
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: sessionUsed,
      resetsAt: inHours(sessionResetHours),
    },
  ];
  return {
    key: `${driver}:${email}`,
    driver: driver as LimitAccount["driver"],
    displayName: null,
    email,
    plan,
    accentColor: undefined,
    environments: [{ environmentId: EnvironmentId.make("mac-a"), label: "mac-a" }],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: new Date(NOW).toISOString(), windows },
  };
}

describe("buildAccountCards", () => {
  const cards = buildAccountCards(
    [
      account("claudeAgent", "owner@gmail.com", "Claude Max 20x Subscription", 70, 1, 20),
      account("claudeAgent", "alice@gmail.com", "Claude Pro Subscription", 10, 4, 40),
      account("codex", "bob@gmail.com", "ChatGPT Plus Subscription", 100, 2, 10),
      account("codex", "alice@gmail.com", "ChatGPT Plus Subscription", 50, 3, 10),
    ],
    NOW,
  );
  const card = (login: string, driver: string) =>
    cards.find((entry) => entry.login === login && entry.account.driver === driver)!;

  it("makes one card per account titled by login, with the plan and tier", () => {
    expect(cards.map((entry) => `${entry.account.driver} ${entry.login} · ${entry.plan}`)).toEqual([
      "claudeAgent alice · Pro",
      "claudeAgent owner · Max 20x",
      "codex alice · Plus",
      "codex bob · Plus",
    ]);
  });

  it("orders each card's windows session first", () => {
    expect(card("owner", "claudeAgent").windows.map((window) => window.kind)).toEqual([
      "session",
      "weekly",
    ]);
    expect(card("owner", "claudeAgent").windows[0]!.remainingPercent).toBe(30);
  });

  it("flags Use now with the Auto account rule, per provider", () => {
    expect(cards.filter((entry) => entry.useNow).map((entry) => entry.login)).toEqual([
      "alice",
      "alice",
    ]);
    expect(card("alice", "claudeAgent").useNow).toBe(true);
    // bob's session is exhausted, so it is limited and skipped.
    expect(card("bob", "codex").useNow).toBe(false);
    expect(card("alice", "codex").useNow).toBe(true);
  });

  it("flags Resets next on the soonest session reset, per provider", () => {
    expect(card("owner", "claudeAgent").resetsNextAt).toBe(NOW + 3_600_000);
    expect(card("alice", "claudeAgent").resetsNextAt).toBeNull();
    expect(card("bob", "codex").resetsNextAt).toBe(NOW + 2 * 3_600_000);
    expect(card("alice", "codex").resetsNextAt).toBeNull();
  });
});

describe("shortPlanLabel", () => {
  it("drops the provider name and the word Subscription", () => {
    expect(shortPlanLabel("Claude Max 20x Subscription")).toBe("Max 20x");
    expect(shortPlanLabel("Claude Max Subscription")).toBe("Max");
    expect(shortPlanLabel("ChatGPT Pro 20x Subscription")).toBe("Pro 20x");
    expect(shortPlanLabel(undefined)).toBeNull();
  });
});

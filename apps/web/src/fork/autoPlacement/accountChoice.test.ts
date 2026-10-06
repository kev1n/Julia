import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { accountStanding, chooseAutoAccount, soonestSessionReset } from "./accountChoice";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function limits(
  session: number | null,
  weekly: number | null,
  extra: ServerProviderUsageWindow[] = [],
  sessionResetsAt = inHours(2),
): ServerProviderUsageLimits {
  const windows: ServerProviderUsageWindow[] = [...extra];
  if (session !== null) {
    windows.push({
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: session,
      resetsAt: sessionResetsAt,
    });
  }
  if (weekly !== null) {
    windows.push({
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: weekly,
      resetsAt: inHours(72),
    });
  }
  return { checkedAt: new Date(NOW).toISOString(), windows };
}

type Account = { readonly name: string; readonly limits: ServerProviderUsageLimits | undefined };
const pick = (accounts: Account[]) =>
  chooseAutoAccount(accounts, (account) => account.limits, NOW)?.account.name ?? null;

describe("chooseAutoAccount", () => {
  it("picks the account with the most session usage left", () => {
    expect(
      pick([
        { name: "max", limits: limits(40, 10) },
        { name: "pro", limits: limits(8, 90) },
      ]),
    ).toBe("pro");
  });

  it("breaks a session tie on weekly remaining", () => {
    expect(
      pick([
        { name: "a", limits: limits(20, 70) },
        { name: "b", limits: limits(20, 30) },
      ]),
    ).toBe("b");
  });

  it("skips a limited account for the next one", () => {
    expect(
      pick([
        { name: "fresh-session-but-weekly-out", limits: limits(0, 100) },
        { name: "next", limits: limits(60, 50) },
      ]),
    ).toBe("next");
  });

  it("counts a window whose reset has passed as full", () => {
    expect(
      pick([
        { name: "reset", limits: limits(100, 10, [], inHours(-1)) },
        { name: "half", limits: limits(50, 10) },
      ]),
    ).toBe("reset");
  });

  it("ranks accounts that report no usage after accounts that do", () => {
    expect(
      pick([
        { name: "unknown", limits: undefined },
        { name: "known", limits: limits(95, 95) },
      ]),
    ).toBe("known");
  });

  it("returns null when every account is limited", () => {
    expect(pick([{ name: "out", limits: limits(100, 20) }])).toBeNull();
  });

  it("uses the tightest weekly window, model-specific ones included", () => {
    const standing = accountStanding(
      limits(10, 20, [
        { id: "seven_day_opus", kind: "weekly", label: "Weekly Opus", usedPercent: 75 },
      ]),
      NOW,
    );
    expect(standing).toEqual({ sessionLeft: 90, weeklyLeft: 25, limited: false });
  });
});

describe("soonestSessionReset", () => {
  it("names the account whose session resets first", () => {
    const accounts: Account[] = [
      { name: "later", limits: limits(10, 10, [], inHours(4)) },
      { name: "sooner", limits: limits(90, 10, [], inHours(1)) },
      { name: "already-reset", limits: limits(90, 10, [], inHours(-1)) },
    ];
    const result = soonestSessionReset(accounts, (account) => account.limits, NOW);
    expect(result?.account.name).toBe("sooner");
    expect(result?.resetsAt).toBe(NOW + 3_600_000);
  });
});

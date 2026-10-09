import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { accountStanding, chooseAutoAccount, soonestSessionReset } from "./accountChoice.ts";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const inHours = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));

function limits(
  session: number | null,
  weekly: number | null,
  extra: ReadonlyArray<ServerProviderUsageWindow> = [],
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
  return { checkedAt: inHours(0), windows };
}

type Account = { readonly name: string; readonly limits: ServerProviderUsageLimits | undefined };
const pick = (accounts: Account[]) =>
  chooseAutoAccount(accounts, (account) => account.limits, NOW)?.account.name ?? null;

describe("chooseAutoAccount", () => {
  it("uses only global and matching model-family windows, including older Claude snapshots", () => {
    const scoped = limits(0, 0, [
      { id: "seven_day_fable", kind: "weekly", label: "Fable", usedPercent: 100 },
      { id: "opus", kind: "weekly", label: "Opus", usedPercent: 20, modelScope: "claude-opus" },
    ]);
    expect(accountStanding(scoped, NOW, "claude-opus-5-5").tightestLeft).toBe(80);
    expect(accountStanding(scoped, NOW, "claude-fable-5").limited).toBe(true);
    expect(accountStanding(scoped, NOW).limited).toBe(true);
    expect(accountStanding(limits(100, 0, scoped.windows), NOW, "claude-opus-5-5").limited).toBe(
      true,
    );
  });
  it("picks the account with the most session usage left", () => {
    expect(
      pick([
        { name: "max", limits: limits(40, 10) },
        { name: "pro", limits: limits(8, 10) },
      ]),
    ).toBe("pro");
  });

  it("ranks by the tightest window: a fresh session cannot outspend a nearly used week", () => {
    expect(
      pick([
        { name: "week-at-90", limits: limits(9, 90) },
        { name: "half-session", limits: limits(50, 20) },
      ]),
    ).toBe("half-session");
  });

  it("treats a week at 99% as used up", () => {
    expect(pick([{ name: "week-at-99", limits: limits(9, 99) }])).toBeNull();
  });

  it("counts a used-up monthly window", () => {
    expect(
      pick([
        {
          name: "month-out",
          limits: limits(0, 0, [
            { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 100 },
          ]),
        },
        { name: "next", limits: limits(60, 50) },
      ]),
    ).toBe("next");
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
    expect(standing).toEqual({
      sessionLeft: 90,
      weeklyLeft: 25,
      monthlyLeft: null,
      tightestLeft: 25,
      limited: false,
    });
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

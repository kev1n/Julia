import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  accountStanding,
  chooseAutoAccount,
  chooseAutoInstance,
  soonestSessionReset,
  withLinkedUsage,
} from "./accountChoice.ts";

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

describe("withLinkedUsage", () => {
  const HUB = UsageLimitSourceId.make("hub");
  const instance = (id: string, usage: ServerProviderUsageLimits | undefined): ServerProvider => ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: inHours(0),
    models: [],
    slashCommands: [],
    skills: [],
    ...(usage ? { usageLimits: usage } : {}),
  });
  const hub = (
    accounts: ReadonlyArray<ServerProviderUsageLimits>,
    extra: Partial<UsageLimitSourceSnapshot> = {},
  ): UsageLimitSourceSnapshot => ({
    id: HUB,
    kind: "cliproxy",
    label: "Hub",
    checkedAt: inHours(0),
    accounts: accounts.map((usageLimits, index) => ({
      id: `account-${index}`,
      driver: ProviderDriverKind.make("claudeAgent"),
      usageLimits,
    })),
    ...extra,
  });
  // The proxy instance's own login is fresh; only the pool may decide its standing.
  const providers = [instance("proxy", limits(0, 0)), instance("direct", limits(50, 50))];
  const links = { proxy: { usageLimitSourceId: HUB } };
  const autoPick = (sources: ReadonlyArray<UsageLimitSourceSnapshot>, model?: string) =>
    chooseAutoInstance(withLinkedUsage(providers, links, sources), "claudeAgent", NOW, model)
      ?.account.instanceId ?? null;

  it("ranks a linked instance by the pool's best account and leaves others alone", () => {
    expect(autoPick([hub([limits(90, 90), limits(20, 10)])])).toBe("proxy");
    expect(autoPick([hub([limits(90, 90), limits(70, 10)])])).toBe("direct");
    expect(withLinkedUsage(providers, {}, [hub([])])).toBe(providers);
  });

  it("never uses the native login when the source fails or is missing", () => {
    for (const sources of [
      [hub([limits(0, 0)], { error: "The hub could not list accounts." })],
      [],
    ]) {
      const proxy = withLinkedUsage(providers, links, sources)[0]!;
      expect(accountStanding(proxy.usageLimits, NOW).tightestLeft).toBeNull();
      expect(autoPick(sources)).toBe("direct");
    }
  });

  it("treats an exhausted or empty pool as limited, counting only the instance's driver", () => {
    const only = [providers[0]!];
    const fresh = hub([limits(0, 0)]);
    const codexOnly = {
      ...fresh,
      accounts: fresh.accounts.map((account) => ({
        ...account,
        driver: ProviderDriverKind.make("codex"),
      })),
    };
    for (const sources of [[hub([limits(100, 10), limits(10, 99)])], [hub([])], [codexOnly]]) {
      expect(chooseAutoInstance(withLinkedUsage(only, links, sources), "claudeAgent", NOW)).toBe(
        null,
      );
    }
  });

  it("takes the best complete account, not per-window maxima: 90/10 and 10/90 are each 10%", () => {
    const crossed = withLinkedUsage(providers, links, [hub([limits(10, 90), limits(90, 10)])]);
    expect(accountStanding(crossed[0]!.usageLimits, NOW).tightestLeft).toBe(10);
    expect(autoPick([hub([limits(10, 90), limits(90, 10)])])).toBe("direct");
  });

  it("reads model-scoped windows for the selected model", () => {
    const opusOut = limits(0, 0, [
      { id: "opus", kind: "weekly", label: "Opus", usedPercent: 100, modelScope: "claude-opus" },
    ]);
    expect(autoPick([hub([opusOut])], "claude-opus-5-5")).toBe("direct");
    expect(autoPick([hub([opusOut])], "claude-sonnet-5")).toBe("proxy");
  });

  it("re-ranks when only the source's usage changes", () => {
    expect(autoPick([hub([limits(10, 10)])])).toBe("proxy");
    expect(autoPick([hub([limits(96, 10)])])).toBe("direct");
  });
});

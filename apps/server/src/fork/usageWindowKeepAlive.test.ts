import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { KEEPALIVE_RETRY_MS, dueKeepAlivePings } from "./usageWindowKeepAlive.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const HOUR = 3_600_000;

function session(resetsAt: number | undefined, usedPercent = 0): ServerProviderUsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt: iso(resetsAt) }),
  };
}

function account(
  instanceId: string,
  email: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  driver = "claudeAgent",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt: iso(NOW),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: iso(NOW), windows },
  };
}

const ids = (providers: ReadonlyArray<ServerProvider>) => providers.map((p) => p.instanceId);

describe("dueKeepAlivePings", () => {
  it("pings accounts whose session window ended or never started, not running ones", () => {
    const providers = [
      account("ended", "a@x.com", [session(NOW - 1000, 40)]),
      account("idle", "b@x.com", [session(undefined)]),
      account("running", "c@x.com", [session(NOW + HOUR, 10)]),
      account("codexEnded", "d@x.com", [session(NOW - 1000)], "codex"),
    ];
    expect(ids(dueKeepAlivePings(providers, NOW, new Map()))).toEqual([
      "ended",
      "idle",
      "codexEnded",
    ]);
  });

  it("pings one instance per login", () => {
    const providers = [
      account("first", "Same@x.com", [session(NOW - 1000)]),
      account("second", "same@x.com", [session(NOW - 1000)]),
    ];
    expect(ids(dueKeepAlivePings(providers, NOW, new Map()))).toEqual(["first"]);
  });

  it("skips accounts with no session window or out of weekly quota", () => {
    const weekly = (usedPercent: number): ServerProviderUsageWindow => ({
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent,
      resetsAt: iso(NOW + 48 * HOUR),
    });
    const providers = [
      account("weeklyOnly", "a@x.com", [weekly(10)], "codex"),
      account("weekSpent", "b@x.com", [session(NOW - 1000), weekly(100)]),
    ];
    expect(dueKeepAlivePings(providers, NOW, new Map())).toEqual([]);
  });

  it("waits before pinging an account again", () => {
    const providers = [account("ended", "a@x.com", [session(NOW - 1000)])];
    const recent = new Map([["claudeAgent:a@x.com", NOW - KEEPALIVE_RETRY_MS + 1000]]);
    const stale = new Map([["claudeAgent:a@x.com", NOW - KEEPALIVE_RETRY_MS]]);
    expect(dueKeepAlivePings(providers, NOW, recent)).toEqual([]);
    expect(ids(dueKeepAlivePings(providers, NOW, stale))).toEqual(["ended"]);
  });
});

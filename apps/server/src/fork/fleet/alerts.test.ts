// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import { type AlertState, decideAlerts, noteText } from "./alerts.ts";
import type { FleetEnvironmentEntry, FleetIntent, FleetThread } from "./model.ts";

const REPO = "github.com/example-com/acme";
const MANIFEST = "server/internal/registry/assets/manifests/google.search.json";
const STALE = 30_000;
const NOW = 1_000_000;

interface Spec {
  readonly env: string;
  readonly id: string;
  readonly lifecycle?: FleetThread["lifecycle"];
  readonly changed?: ReadonlyArray<string>;
  readonly intents?: ReadonlyArray<FleetIntent>;
}

function entries(specs: ReadonlyArray<Spec>, staleEnvs: ReadonlyArray<string> = []) {
  const byEnv = new Map<string, FleetEnvironmentEntry>();
  for (const spec of specs) {
    const entry = byEnv.get(spec.env) ?? {
      receivedAt: staleEnvs.includes(spec.env) ? NOW - STALE - 1 : NOW,
      snapshot: {
        environmentId: spec.env,
        label: spec.env,
        baseUrl: `https://${spec.env}.example`,
        incarnation: "i",
        seq: 1,
        complete: true,
        lastScanAt: NOW,
        threads: [],
        checkouts: [],
      },
    };
    const key = `${spec.env}:/wt/${spec.id}`;
    byEnv.set(spec.env, {
      ...entry,
      snapshot: {
        ...entry.snapshot,
        threads: [
          ...entry.snapshot.threads,
          {
            environmentId: spec.env,
            threadId: spec.id,
            title: `Chat ${spec.id}`,
            projectId: "p",
            repoKey: REPO,
            branch: `t3/${spec.id}`,
            checkoutKey: key,
            lifecycle: spec.lifecycle ?? "running",
            runtimeMode: "full-access",
            providerInstanceId: "claudeAgent",
            model: "claude-opus-5-5",
            lastActivityAt: NOW,
            intents: spec.intents ?? [],
            intentsAt: spec.intents ? NOW : null,
          },
        ],
        checkouts: [
          ...entry.snapshot.checkouts,
          {
            key,
            path: `/wt/${spec.id}`,
            repoKey: REPO,
            branch: `t3/${spec.id}`,
            head: "h",
            base: { ref: "origin/main", sha: "b" },
            changes: (spec.changed ?? []).map((path) => ({
              path,
              kind: "unstaged" as const,
              change: "M" as const,
            })),
            scannedAt: NOW,
          },
        ],
      },
    });
  }
  return [...byEnv.values()];
}

const decide = (
  environmentId: string,
  index: ReadonlyArray<FleetEnvironmentEntry>,
  state: AlertState = {},
) => decideAlerts({ environmentId, entries: index, now: NOW, staleAfterMs: STALE, state });

/** What the hub does after a successful delivery. */
const delivered = (state: AlertState): AlertState =>
  Object.fromEntries(
    Object.entries(state).map(([key, pair]) => [key, { ...pair, delivered: true }]),
  );

const notices = (result: ReturnType<typeof decide>) =>
  result.decisions.flatMap((decision) =>
    decision.action === "notify"
      ? [`${decision.recipient.thread.threadId}:${decision.level}:${decision.reason}`]
      : [],
  );

describe("decideAlerts", () => {
  it("interrupts both chats once when both are running and edit the same file", () => {
    const index = entries([
      { env: "mac-a", id: "a", changed: [MANIFEST] },
      { env: "build-mac", id: "b", changed: [MANIFEST] },
    ]);
    const first = decide("mac-a", index);
    expect(notices(first).sort()).toEqual(["a:interrupt:new", "b:interrupt:new"]);

    // Every later heartbeat, from either machine, finds the same file set: nothing new.
    const state = delivered(first.state);
    expect(decide("mac-a", index, state).decisions).toEqual([]);
    expect(decide("build-mac", index, state).decisions).toEqual([]);
  });

  it("waits for the next turn (passive) when one side is idle, and escalates when both work", () => {
    const idle = entries([
      { env: "mac-a", id: "a", changed: [MANIFEST] },
      { env: "build-mac", id: "b", changed: [MANIFEST], lifecycle: "idle" },
    ]);
    const first = decide("build-mac", idle);
    expect(notices(first).sort()).toEqual(["a:passive:new", "b:passive:new"]);

    const working = entries([
      { env: "mac-a", id: "a", changed: [MANIFEST] },
      { env: "build-mac", id: "b", changed: [MANIFEST] },
    ]);
    const second = decide("build-mac", working, delivered(first.state));
    expect(notices(second).sort()).toEqual(["a:interrupt:escalated", "b:interrupt:escalated"]);

    // Back to idle with the same files: no step down, no repeat.
    expect(decide("build-mac", idle, delivered(second.state)).decisions).toEqual([]);
  });

  it("is passive when the overlap is only an area (a declared directory) or a read", () => {
    const index = entries([
      { env: "mac-a", id: "a", changed: [MANIFEST] },
      {
        env: "build-mac",
        id: "b",
        intents: [{ key: "server/internal/registry/assets/manifests/", access: "write" }],
      },
      { env: "build-mac", id: "c", intents: [{ key: MANIFEST, access: "read" }] },
    ]);
    expect(notices(decide("mac-a", index)).sort()).toEqual([
      "a:passive:new",
      "a:passive:new",
      "b:passive:new",
      "c:passive:new",
    ]);
  });

  it("interrupts on a declared write of the exact file against an observed edit", () => {
    const index = entries([
      { env: "mac-a", id: "a", changed: [MANIFEST] },
      { env: "build-mac", id: "b", intents: [{ key: MANIFEST, access: "write" }] },
    ]);
    expect(notices(decide("mac-a", index)).sort()).toEqual(["a:interrupt:new", "b:interrupt:new"]);
  });

  it("says nothing when the chats touch different files", () => {
    const index = entries([
      { env: "mac-a", id: "a", changed: ["src/a.ts"] },
      { env: "build-mac", id: "b", changed: ["src/b.ts"] },
    ]);
    expect(decide("mac-a", index)).toEqual({ decisions: [], state: {} });
  });

  it("re-notifies when the file set changes and withdraws when the overlap ends", () => {
    const one = entries([
      { env: "mac-a", id: "a", changed: [MANIFEST] },
      { env: "build-mac", id: "b", changed: [MANIFEST], lifecycle: "idle" },
    ]);
    const first = decide("mac-a", one);
    const two = entries([
      { env: "mac-a", id: "a", changed: [MANIFEST, "src/x.ts"] },
      { env: "build-mac", id: "b", changed: [MANIFEST, "src/x.ts"], lifecycle: "idle" },
    ]);
    const second = decide("mac-a", two, delivered(first.state));
    expect(notices(second).sort()).toEqual(["a:passive:changed", "b:passive:changed"]);

    const none = entries([
      { env: "mac-a", id: "a", changed: ["src/a.ts"] },
      { env: "build-mac", id: "b", changed: ["src/b.ts"], lifecycle: "idle" },
    ]);
    const third = decide("mac-a", none, delivered(second.state));
    expect(third.decisions.map((decision) => decision.action)).toEqual(["withdraw", "withdraw"]);
    expect(third.state).toEqual({});
  });

  it("defers a note for a stale machine once, and delivers it when the machine is back", () => {
    const stale = entries(
      [
        { env: "mac-a", id: "a", changed: [MANIFEST] },
        { env: "MacBook", id: "b", changed: [MANIFEST] },
      ],
      ["MacBook"],
    );
    const first = decide("mac-a", stale);
    // The fresh side is told (passive: the stale side may not really be running).
    expect(notices(first)).toEqual(["a:passive:new"]);
    expect(first.decisions.filter((decision) => decision.action === "defer")).toHaveLength(1);
    const told = first.decisions.find((decision) => decision.action === "notify")!.key;
    const kept = { ...first.state, [told]: { ...first.state[told]!, delivered: true } };
    expect(decide("mac-a", stale, kept).decisions).toEqual([]);

    const back = entries([
      { env: "mac-a", id: "a", changed: [MANIFEST] },
      { env: "MacBook", id: "b", changed: [MANIFEST] },
    ]);
    const second = decide("MacBook", back, kept);
    expect(notices(second).sort()).toEqual(["a:interrupt:escalated", "b:interrupt:escalated"]);
  });
});

describe("noteText", () => {
  it("names the other chat, its machine, the file and evidence, links it, and states freshness and coverage", () => {
    const index = entries([
      { env: "mac-a", id: "a", changed: [MANIFEST] },
      { env: "build-mac", id: "b", intents: [{ key: MANIFEST, access: "write" }] },
    ]);
    const decision = decide("mac-a", index).decisions.find(
      (candidate) => candidate.action === "notify" && candidate.recipient.thread.threadId === "a",
    );
    if (decision?.action !== "notify") throw new Error("no notice");
    const text = noteText({
      ...decision,
      entries: index,
      now: NOW,
      staleAfterMs: STALE,
      hubLabel: "mac-a",
    });
    expect(text).toContain('"Chat b" on build-mac');
    expect(text).toContain("https://build-mac.example/build-mac/b");
    expect(text).toContain(
      `${MANIFEST} (SKU google.search): you observed (unstaged, M); them declared write`,
    );
    expect(text).toContain(`as of ${new Date(NOW).toISOString()}`);
    expect(text).toContain("covers mac-a (fresh, last heartbeat 0 s ago), build-mac (fresh");
    expect(text).toContain("nothing was stopped, merged or redirected");
  });
});

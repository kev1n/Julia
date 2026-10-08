import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as FleetSuggestions from "./threadOverlaps.ts";
import type { FleetSnapshot, FleetThread } from "./model.ts";
import type { FleetView } from "./view.ts";
import { workContext } from "./workContext.ts";

const state = vi.hoisted(() => ({
  local: null as FleetSnapshot | null,
  view: null as FleetView | null,
}));
vi.mock("./publisher.ts", () => ({
  fleetConfig: () => ({
    userdataDir: "/tmp",
    hubUrl: "https://hub",
    selfUrl: "https://local",
    secret: "test",
    hub: true,
  }),
  localSnapshot: () => state.local,
}));
vi.mock("./view.ts", () => ({
  loadView: async () =>
    state.view === null
      ? null
      : {
          ...state.view,
          entries: state.view.entries.map((entry) =>
            entry.snapshot.environmentId === state.local?.environmentId
              ? { ...entry, snapshot: state.local }
              : entry,
          ),
        },
}));
const thread = (id: string, overrides: Partial<FleetThread> = {}): FleetThread => ({
  environmentId: "local",
  threadId: id,
  title: id,
  projectId: "p",
  repoKey: "repo",
  branch: id,
  checkoutKey: `local:/tmp/${id}`,
  lifecycle: "running",
  runtimeMode: "full-access",
  providerInstanceId: "codex",
  model: "gpt-6-sol",
  lastActivityAt: 0,
  intents: [],
  intentsAt: null,
  workContext: "User: Investigate dropped messages after reconnect.",
  ...overrides,
});
function setup(others = [thread("other")]) {
  state.local = {
    environmentId: "local",
    label: "build-mac",
    baseUrl: "https://local",
    incarnation: "i",
    seq: 1,
    complete: true,
    lastScanAt: 0,
    threads: [thread("me"), ...others],
    checkouts: [],
  };
  state.view = {
    asOf: "now",
    now: 0,
    hub: "reachable",
    entries: [{ snapshot: state.local, receivedAt: 0 }],
    coverage: [
      {
        environmentId: "local",
        label: "build-mac",
        status: "fresh",
        heartbeatAt: null,
        lastScanAt: null,
        threadCount: others.length + 1,
      },
    ],
  };
}
const providerLayer = (generate: ProviderInstance["textGeneration"]["generateFleetRelations"]) => {
  // Only external provider capabilities are mocked, not candidate selection/caching.
  const provider = {
    instanceId: ProviderInstanceId.make("codex"),
    driverKind: "codex",
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({ installed: true, models: [{ slug: "gpt-6-luna" }] }),
    },
    textGeneration: { generateFleetRelations: generate },
  } as unknown as ProviderInstance;
  return Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    listInstances: Effect.succeed([provider]),
  });
};
const withService = (
  generate: ProviderInstance["textGeneration"]["generateFleetRelations"],
  test: (service: FleetSuggestions.FleetSuggestions["Service"]) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    return yield* test(yield* FleetSuggestions.FleetSuggestions);
  }).pipe(Effect.provide(FleetSuggestions.layer.pipe(Layer.provide(providerLayer(generate)))));

describe("intent suggestions", () => {
  it.effect(
    "finds duplicate investigations without shared files and caches heartbeat changes",
    () => {
      setup();
      let calls = 0;
      return withService(
        (input) =>
          Effect.sync(() => {
            calls++;
            expect(input.modelSelection.model).toBe("gpt-6-luna");
            expect(input.context).toContain("dropped messages");
            return {
              suggestions: [
                {
                  aId: "local/me",
                  bId: "local/other",
                  kind: "duplicate_investigation" as const,
                  reason: "Both investigate reconnect losing messages.",
                },
                {
                  aId: "local/me",
                  bId: "local/fabricated",
                  kind: "conflicting_intent" as const,
                  reason: "Invented",
                },
              ],
            };
          }),
        (service) =>
          Effect.gen(function* () {
            const result = yield* service.read("me", { wait: true });
            expect(result.status).toBe("ready");
            expect(result.overlaps).toHaveLength(1);
            expect(result.overlaps[0]?.reason).toBe("Both investigate reconnect losing messages.");
            state.local = { ...state.local!, seq: 2, lastScanAt: 123 };
            yield* service.read("me", { wait: true });
            expect(calls).toBe(1);
            const reverse = yield* service.read("other", { wait: true });
            expect(reverse.overlaps[0]?.threadId).toBe("me");
            expect(calls).toBe(1);
          }),
      );
    },
  );
  it.effect("does not turn raw shared file evidence into a suggestion", () => {
    setup();
    state.local = {
      ...state.local!,
      checkouts: ["me", "other"].map((id) => ({
        key: `local:/tmp/${id}`,
        path: `/tmp/${id}`,
        repoKey: "repo",
        branch: id,
        head: "h",
        base: null,
        scannedAt: 0,
        changes: [{ path: "package.json", kind: "unstaged", change: "M" }],
      })),
    };
    return withService(
      () => Effect.succeed({ suggestions: [] }),
      (service) =>
        Effect.gen(function* () {
          expect(yield* service.read("me", { wait: true })).toEqual({
            status: "ready",
            overlaps: [],
          });
        }),
    );
  });
  it.effect("coalesces requests while judging and lets agent callers await completion", () => {
    setup();
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      return yield* withService(
        () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return { suggestions: [] };
          }),
        (service) =>
          Effect.gen(function* () {
            expect((yield* service.read("me")).status).toBe("checking");
            yield* Deferred.await(entered);
            expect((yield* service.read("me")).status).toBe("checking");
            expect(calls).toBe(1);
            yield* Deferred.succeed(release, undefined);
            expect((yield* service.read("me", { wait: true })).status).toBe("ready");
          }),
      );
    });
  });
  it.effect("hides invalidated reasons, then judges changed goals after the cooldown", () => {
    setup();
    let calls = 0;
    return withService(
      () =>
        Effect.sync(() => {
          calls++;
          return {
            suggestions: [
              {
                aId: "local/me",
                bId: "local/other",
                kind: "conflicting_intent" as const,
                reason: "Opposing reconnect behavior.",
              },
            ],
          };
        }),
      (service) =>
        Effect.gen(function* () {
          expect((yield* service.read("me", { wait: true })).overlaps).toHaveLength(1);
          state.local = {
            ...state.local!,
            threads: state.local!.threads.map((t) =>
              t.threadId === "me" ? { ...t, workContext: "User: Remove reconnect retries." } : t,
            ),
          };
          expect((yield* service.read("me")).overlaps).toHaveLength(0);
          expect(calls).toBe(1);
          yield* TestClock.adjust("5 minutes");
          yield* service.read("me", { wait: true });
          expect(calls).toBe(2);
        }),
    );
  });
  it.effect("ignores stale, settled, unknown-context and unrelated-repository candidates", () => {
    setup([
      thread("settled", { lifecycle: "settled" }),
      thread("unrelated", { repoKey: "other-repo" }),
      thread("old", { workContext: undefined }),
    ]);
    return withService(
      () => Effect.die("No eligible candidates should invoke the model"),
      (service) =>
        Effect.gen(function* () {
          expect((yield* service.read("me")).overlaps).toEqual([]);
          setup();
          state.view = {
            ...state.view!,
            coverage: [{ ...state.view!.coverage[0]!, status: "stale" }],
          };
          expect((yield* service.read("me")).overlaps).toEqual([]);
        }),
    );
  });
  it.effect("reports provider failures as unavailable and backs off retries", () => {
    setup();
    let calls = 0;
    return withService(
      () =>
        Effect.sync(() => {
          calls++;
        }).pipe(Effect.andThen(Effect.die("offline"))),
      (service) =>
        Effect.gen(function* () {
          expect((yield* service.read("me", { wait: true })).status).toBe("unavailable");
          yield* TestClock.adjust("61 seconds");
          yield* service.read("me", { wait: true });
          expect(calls).toBe(1);
          yield* TestClock.adjust("5 minutes");
          yield* service.read("me", { wait: true });
          expect(calls).toBe(2);
        }),
    );
  });
  it.effect("caps checks across repositories and releases the budget after ten minutes", () => {
    let calls = 0;
    return withService(
      () =>
        Effect.sync(() => {
          calls++;
          return { suggestions: [] };
        }),
      (service) =>
        Effect.gen(function* () {
          for (let i = 0; i < 4; i++) {
            setup();
            state.local = {
              ...state.local!,
              threads: state.local!.threads.map((t) => ({ ...t, repoKey: `repo-${i}` })),
            };
            const result = yield* service.read("me", { wait: true });
            expect(result.status).toBe(i === 3 ? "checking" : "ready");
          }
          expect(calls).toBe(3);
          yield* TestClock.adjust("10 minutes");
          expect((yield* service.read("me", { wait: true })).status).toBe("ready");
          expect(calls).toBe(4);
        }),
    );
  });
  it.effect("preserves valid pair reasons when an unrelated chat changes", () => {
    setup([thread("other"), thread("unrelated")]);
    let calls = 0;
    return withService(
      () =>
        Effect.sync(() => {
          calls++;
          return {
            suggestions: [
              {
                aId: "local/me",
                bId: "local/other",
                kind: "duplicate_investigation" as const,
                reason: "Same reconnect bug.",
              },
            ],
          };
        }),
      (service) =>
        Effect.gen(function* () {
          yield* service.read("me", { wait: true });
          state.local = {
            ...state.local!,
            threads: state.local!.threads.map((t) =>
              t.threadId === "unrelated" ? { ...t, workContext: "User: Add a meter instead." } : t,
            ),
          };
          expect((yield* service.read("me")).overlaps[0]?.reason).toBe("Same reconnect bug.");
          expect(calls).toBe(1);
        }),
    );
  });
  it.effect("bounds a many-chat prompt and explicitly requests low reasoning", () => {
    setup(
      Array.from({ length: 23 }, (_, i) => thread(`peer-${i}`, { workContext: "x".repeat(8400) })),
    );
    return withService(
      (input) =>
        Effect.sync(() => {
          expect(input.context.length).toBeLessThanOrEqual(64_000);
          expect(input.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "low" }]);
          return { suggestions: [] };
        }),
      (service) =>
        Effect.gen(function* () {
          expect((yield* service.read("me", { wait: true })).status).toBe("ready");
        }),
    );
  });
});
describe("published work context", () => {
  it("keeps original goals, recent steering and agent findings but excludes automatic notices", () => {
    const result = workContext(
      [
        { text: "Add reconnect retries" },
        { text: "Old detail" },
        { text: "Another old detail" },
        { text: "[Fleet overlap alert] Shared package.json" },
        { text: "Context handoff: old alerts" },
        { text: "Investigate dropped messages" },
        { text: "Remove retries instead" },
        { text: "[Fleet overlap note] Same ChatView file" },
      ],
      [{ text: "Found reconnect drops queued messages" }],
    );
    expect(result).toContain("Add reconnect retries");
    expect(result).toContain("Remove retries instead");
    expect(result).toContain("Found reconnect drops queued messages");
    expect(result).not.toContain("Shared package.json");
    expect(result).not.toContain("Same ChatView file");
    expect(result).not.toContain("Context handoff");
    expect(result).not.toContain("User: Old detail");
    expect(
      workContext([{ text: "x".repeat(20000) }], [{ text: "y".repeat(20000) }]).length,
    ).toBeLessThanOrEqual(8400);
  });
});

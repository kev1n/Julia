import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { accountWithLimitLeft } from "../fork/accountWithLimitLeft.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinkedUsageProviderRegistry from "./LinkedUsageProviderRegistry.ts";
import { UsageLimitSources } from "./UsageLimitSources.ts";

const AT = "2026-11-02T00:00:00.000Z";
const NOW = Date.parse(AT);
const driver = ProviderDriverKind.make("claudeAgent");
const MODEL = "claude-opus-5-5";
const session = (usedPercent: number) => ({
  checkedAt: AT,
  windows: [{ id: "five_hour", kind: "session" as const, label: "Session", usedPercent }],
});
const instance = (id: string, sessionUsed: number): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: AT,
  models: [{ slug: MODEL, name: "Opus", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: session(sessionUsed),
});
const hub = (sessionUsed: number): ReadonlyArray<UsageLimitSourceSnapshot> => [
  {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy",
    label: "Hub",
    checkedAt: AT,
    accounts: [{ id: "pooled", driver, usageLimits: session(sessionUsed) }],
  },
];
// The proxy instance's own login is fresh; only the hub's account may decide its standing.
const providers = [instance("proxy", 0), instance("direct", 50)];
const PROXY = { instanceId: ProviderInstanceId.make("proxy"), model: MODEL };

const testLayer = (
  current: Ref.Ref<ReadonlyArray<UsageLimitSourceSnapshot>>,
  changes: Queue.Queue<ReadonlyArray<UsageLimitSourceSnapshot>>,
) =>
  LinkedUsageProviderRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed(providers),
          streamChanges: Stream.never,
        }),
        Layer.mock(UsageLimitSources)({
          current: Ref.get(current),
          streamChanges: Stream.concat(
            Stream.fromEffect(Ref.get(current)),
            Stream.fromQueue(changes),
          ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              [ProviderInstanceId.make("proxy")]: {
                driver,
                usageLimitSourceId: UsageLimitSourceId.make("hub"),
              },
            },
          }),
        }),
      ),
    ),
  );

it.effect("server-side choosers read a linked instance's hub usage, not its login", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(hub(97));
    const changes = yield* Queue.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>();
    const registry = yield* ProviderRegistry.pipe(Effect.provide(testLayer(current, changes)));
    const listed = yield* registry.getProviders;
    // The hub's only account is used up, so the proxy instance is limited and work moves.
    expect(accountWithLimitLeft(PROXY, listed, NOW).instanceId).toBe("direct");
    expect(listed[1]).toBe(providers[1]);
  }),
);

it.effect("re-emits the providers when only the hub's usage changes", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(hub(10));
    const changes = yield* Queue.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>();
    const registry = yield* ProviderRegistry.pipe(Effect.provide(testLayer(current, changes)));
    const next = yield* registry.streamChanges.pipe(Stream.runHead, Effect.forkChild);
    yield* Ref.set(current, hub(97));
    yield* Queue.offer(changes, hub(97));
    const emitted = yield* Fiber.join(next);
    expect(emitted._tag).toBe("Some");
    if (emitted._tag !== "Some") return;
    expect(accountWithLimitLeft(PROXY, emitted.value, NOW).instanceId).toBe("direct");
  }),
);

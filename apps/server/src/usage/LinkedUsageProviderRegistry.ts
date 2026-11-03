/**
 * Fork: the provider list every server consumer reads, with each instance linked to a usage
 * limit source reporting that source's accounts (`withLinkedUsage`) instead of its own login.
 * Wraps the registry, so composer clients, server-side selection, failover and autofix share it,
 * and re-emits when only a source's usage changes.
 */
import type { ServerProvider, ServerSettings, UsageLimitSourceSnapshot } from "@t3tools/contracts";
import { withLinkedUsage } from "@t3tools/shared/accountChoice";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { UsageLimitSources } from "./UsageLimitSources.ts";

type Instances = ServerSettings["providerInstances"];

/** No links were ever read, so any instance may be linked: none may show its login's usage. */
const withUnknownUsage = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  usageLimits: {
    checkedAt: provider.checkedAt,
    windows: [],
    unavailable: {
      reason: "probeFailed",
      message: "Could not read which usage limit source this instance is linked to.",
    },
  },
});

/** Decorates the `ProviderRegistry` it is given; provide the plain registry layer to it. */
export const layer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const sources = yield* UsageLimitSources;
    const settings = yield* Settings.ServerSettingsService;
    // A failed settings read keeps the last links read; it never reverts linked instances to
    // their own login's usage.
    const knownInstances = yield* Ref.make<Instances | undefined>(undefined);
    const linked = Effect.fn("LinkedUsageProviderRegistry.linked")(function* (
      providers: ReadonlyArray<ServerProvider>,
      snapshot?: ReadonlyArray<UsageLimitSourceSnapshot>,
    ) {
      const instances = yield* settings.getSettings.pipe(
        Effect.map((value) => value.providerInstances),
        Effect.tap((value) => Ref.set(knownInstances, value)),
        Effect.catch(() => Ref.get(knownInstances)),
      );
      if (instances === undefined) return providers.map(withUnknownUsage);
      return withLinkedUsage(providers, instances, snapshot ?? (yield* sources.current));
    });
    const link =
      <A extends ReadonlyArray<unknown>>(
        refresh: (...args: A) => Effect.Effect<ReadonlyArray<ServerProvider>>,
      ) =>
      (...args: A) =>
        refresh(...args).pipe(Effect.flatMap((providers) => linked(providers)));
    return {
      ...registry,
      getProviders: registry.getProviders.pipe(Effect.flatMap((providers) => linked(providers))),
      refresh: link(registry.refresh),
      refreshInstance: link(registry.refreshInstance),
      refreshAfterUpdate: link(registry.refreshAfterUpdate),
      refreshWorkspaceSnapshot: link(registry.refreshWorkspaceSnapshot),
      setProviderMaintenanceActionState: link(registry.setProviderMaintenanceActionState),
      // Starts with the current pair, so a source change between a caller's read and its
      // subscription is not lost; callers already drop values equal to what they hold.
      get streamChanges() {
        return Stream.zipLatestWith(
          Stream.concat(Stream.fromEffect(registry.getProviders), registry.streamChanges),
          sources.streamChanges,
          (providers, snapshot) => ({ providers, snapshot }),
        ).pipe(Stream.mapEffect(({ providers, snapshot }) => linked(providers, snapshot)));
      },
    } satisfies ProviderRegistry["Service"];
  }),
);

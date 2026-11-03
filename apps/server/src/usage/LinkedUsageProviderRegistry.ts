/**
 * Fork: the provider list every server consumer reads, with each instance linked to a usage
 * limit source reporting that source's accounts (`withLinkedUsage`) instead of its own login.
 * Wraps the registry, so composer clients, server-side selection, failover and autofix share it,
 * and re-emits when only a source's usage changes.
 */
import type { ServerProvider, UsageLimitSourceSnapshot } from "@t3tools/contracts";
import { withLinkedUsage } from "@t3tools/shared/accountChoice";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { UsageLimitSources } from "./UsageLimitSources.ts";

/** Decorates the `ProviderRegistry` it is given; provide the plain registry layer to it. */
export const layer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const sources = yield* UsageLimitSources;
    const settings = yield* Settings.ServerSettingsService;
    const linked = Effect.fn("LinkedUsageProviderRegistry.linked")(function* (
      providers: ReadonlyArray<ServerProvider>,
      snapshot?: ReadonlyArray<UsageLimitSourceSnapshot>,
    ) {
      const instances = yield* settings.getSettings.pipe(
        Effect.map((value) => value.providerInstances),
        Effect.orElseSucceed(() => ({})),
      );
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
      // Changes only, like the registry's own stream: the seeded pair is dropped.
      get streamChanges() {
        return Stream.zipLatestWith(
          Stream.concat(Stream.fromEffect(registry.getProviders), registry.streamChanges),
          sources.streamChanges,
          (providers, snapshot) => ({ providers, snapshot }),
        ).pipe(
          Stream.mapEffect(({ providers, snapshot }) => linked(providers, snapshot)),
          Stream.drop(1),
        );
      },
    } satisfies ProviderRegistry["Service"];
  }),
);

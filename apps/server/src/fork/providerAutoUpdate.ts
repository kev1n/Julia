/**
 * Fork: install a newer Codex CLI as soon as the update check finds one, so a model that needs
 * it is usable without pressing Update. Follows the "check for provider updates" setting. One
 * attempt per version, so a release this server refuses or an install that fails is not retried
 * every tick; a restart tries it once more.
 */
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ProviderMaintenanceRunner } from "../provider/providerMaintenanceRunner.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ForkDrain from "./drain.ts";

const CODEX = ProviderDriverKind.make("codex");

/** The first Codex instance with a newer version this server can install and has not tried. */
export function nextAutoUpdate(
  providers: ReadonlyArray<ServerProvider>,
  attempted: ReadonlyMap<string, string>,
): (ServerProvider & { readonly latestVersion: string }) | undefined {
  for (const provider of providers) {
    const advisory = provider.versionAdvisory;
    const updating =
      provider.updateState?.status === "queued" || provider.updateState?.status === "running";
    if (
      provider.driver === CODEX &&
      provider.enabled &&
      !updating &&
      advisory?.status === "behind_latest" &&
      advisory.canUpdate &&
      advisory.latestVersion !== null &&
      attempted.get(provider.instanceId) !== advisory.latestVersion
    ) {
      return { ...provider, latestVersion: advisory.latestVersion };
    }
  }
  return undefined;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry;
    const settings = yield* ServerSettings.ServerSettingsService;
    const maintenance = yield* ProviderMaintenanceRunner;
    const scheduler = yield* Scheduler.Scheduler;
    const attempted = yield* Ref.make(new Map<string, string>());

    const update = Effect.fn("ProviderAutoUpdate.update")(function* (
      provider: ServerProvider & { readonly latestVersion: string },
    ) {
      const { instanceId, latestVersion } = provider;
      yield* Ref.update(attempted, (current) => new Map(current).set(instanceId, latestVersion));
      yield* maintenance.updateProvider({ provider: provider.driver, instanceId }).pipe(
        Effect.tap((result) => {
          const after = result.providers.find((candidate) => candidate.instanceId === instanceId);
          return Effect.logInfo("provider-auto-update.finished", {
            instanceId,
            from: provider.version,
            latestVersion,
            version: after?.version,
            status: after?.updateState?.status,
            message: after?.updateState?.message,
          });
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider-auto-update.failed", { instanceId, latestVersion, cause }),
        ),
      );
    });

    const sweep = Effect.gen(function* () {
      if (!(yield* settings.getSettings).enableProviderUpdateChecks) return;
      const due = nextAutoUpdate(yield* providers.getProviders, yield* Ref.get(attempted));
      if (!due) return;
      yield* ForkDrain.unlessDraining(`installing Codex ${due.latestVersion}`, update(due));
    });

    yield* scheduler.register("provider-auto-update", sweep);
  }),
);

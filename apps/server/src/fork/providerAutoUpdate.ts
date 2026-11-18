/**
 * Fork: install newer agent CLIs without pressing Update (FORK.md, "Codex and Claude Code update
 * themselves"): Codex's newest release at once, Claude Code's newest that is three days old.
 * One attempt per version until restart, so a refused or failed install is not retried each tick.
 */
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { ProviderMaintenanceRunner } from "../provider/providerMaintenanceRunner.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ForkDrain from "./drain.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
export const CLAUDE_MINIMUM_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// The native installer's versions are the npm package's, and only npm dates them.
const CLAUDE_RELEASES = "https://registry.npmjs.org/@anthropic-ai/claude-code";
const RELEASES_RETRY_MS = 60 * 60 * 1000;
const ReleaseTimes = Schema.Struct({ time: Schema.Record(Schema.String, Schema.String) });

type ReleaseTimes = Readonly<Record<string, string>>;

export interface AutoUpdate {
  readonly provider: ServerProvider;
  readonly version: string;
  /** Install exactly `version` instead of whatever is newest. */
  readonly pinned: boolean;
}

/** The newest plain release newer than `installed` that was published `minimumAgeMs` ago or more. */
export function agedRelease(
  times: ReleaseTimes,
  installed: string,
  now: number,
  minimumAgeMs: number,
): string | undefined {
  let newest: string | undefined;
  for (const [version, publishedAt] of Object.entries(times)) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const published = Date.parse(publishedAt);
    if (!Number.isFinite(published) || now - published < minimumAgeMs) continue;
    if (compareSemverVersions(version, newest ?? installed) > 0) newest = version;
  }
  return newest;
}

const behind = (provider: ServerProvider) => {
  const advisory = provider.versionAdvisory;
  const updating =
    provider.updateState?.status === "queued" || provider.updateState?.status === "running";
  return provider.enabled &&
    !updating &&
    advisory?.status === "behind_latest" &&
    advisory.canUpdate &&
    advisory.latestVersion !== null
    ? { ...advisory, latestVersion: advisory.latestVersion }
    : undefined;
};

/** The newest Claude Code release the update check saw on an instance this server can pin. */
function claudeLatestVersion(providers: ReadonlyArray<ServerProvider>): string | undefined {
  for (const provider of providers) {
    const advisory = provider.driver === CLAUDE ? behind(provider) : undefined;
    if (advisory?.canInstallVersion) return advisory.latestVersion;
  }
  return undefined;
}

/** The first instance with a version to install that was not tried yet. */
export function nextAutoUpdate(
  providers: ReadonlyArray<ServerProvider>,
  attempted: ReadonlyMap<string, string>,
  claudeReleases: ReleaseTimes | null,
  now: number,
): AutoUpdate | undefined {
  for (const provider of providers) {
    const advisory = behind(provider);
    if (!advisory) continue;
    const installed = advisory.currentVersion ?? provider.version;
    const update =
      provider.driver === CODEX
        ? { version: advisory.latestVersion, pinned: false }
        : provider.driver === CLAUDE && advisory.canInstallVersion && claudeReleases && installed
          ? {
              version: agedRelease(claudeReleases, installed, now, CLAUDE_MINIMUM_AGE_MS),
              pinned: true,
            }
          : undefined;
    if (update?.version === undefined || attempted.get(provider.instanceId) === update.version) {
      continue;
    }
    return { provider, version: update.version, pinned: update.pinned };
  }
  return undefined;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry;
    const settings = yield* ServerSettings.ServerSettingsService;
    const maintenance = yield* ProviderMaintenanceRunner;
    const scheduler = yield* Scheduler.Scheduler;
    const http = yield* HttpClient.HttpClient;
    const attempted = yield* Ref.make(new Map<string, string>());
    const fetched = yield* Ref.make<{
      readonly latest: string;
      readonly at: number;
      readonly times: ReleaseTimes | null;
    } | null>(null);

    // Release dates never change, so one read serves until a newer release appears.
    const claudeReleases = Effect.fn("ProviderAutoUpdate.claudeReleases")(function* (
      latest: string,
      now: number,
    ) {
      const cached = yield* Ref.get(fetched);
      if (
        cached?.latest === latest &&
        (cached.times !== null || now - cached.at < RELEASES_RETRY_MS)
      ) {
        return cached.times;
      }
      const times = yield* http.get(CLAUDE_RELEASES).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(ReleaseTimes)),
        Effect.map((releases) => releases.time),
        Effect.timeoutOption("20 seconds"),
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      yield* Ref.set(fetched, { latest, at: now, times });
      return times;
    });

    const update = Effect.fn("ProviderAutoUpdate.update")(function* (due: AutoUpdate) {
      const { instanceId, driver } = due.provider;
      yield* Ref.update(attempted, (current) => new Map(current).set(instanceId, due.version));
      yield* maintenance
        .updateProvider({
          provider: driver,
          instanceId,
          ...(due.pinned ? { targetVersion: due.version, unrecommended: true } : {}),
        })
        .pipe(
          Effect.tap((result) => {
            const after = result.providers.find((candidate) => candidate.instanceId === instanceId);
            return Effect.logInfo("provider-auto-update.finished", {
              instanceId,
              from: due.provider.version,
              target: due.version,
              version: after?.version,
              status: after?.updateState?.status,
              message: after?.updateState?.message,
            });
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider-auto-update.failed", {
              instanceId,
              target: due.version,
              cause,
            }),
          ),
        );
    });

    const sweep = Effect.gen(function* () {
      if (!(yield* settings.getSettings).enableProviderUpdateChecks) return;
      const current = yield* providers.getProviders;
      const now = yield* Clock.currentTimeMillis;
      const claudeLatest = claudeLatestVersion(current);
      const releases = claudeLatest === undefined ? null : yield* claudeReleases(claudeLatest, now);
      const due = nextAutoUpdate(current, yield* Ref.get(attempted), releases, now);
      if (!due) return;
      const name = due.provider.driver === CODEX ? "Codex" : "Claude Code";
      yield* ForkDrain.unlessDraining(`installing ${name} ${due.version}`, update(due));
    });

    yield* scheduler.register("provider-auto-update", sweep);
  }),
);

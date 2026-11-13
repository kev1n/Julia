/**
 * Fork: when a Claude or Codex account's 5-hour window has ended, send one tiny prompt on
 * its smallest model so the next window starts at once (one per login email). Accounts without a
 * session window or out of quota are skipped. Off by default; turn it on in one environment only.
 */
import {
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { accountStanding, usableInstances } from "@t3tools/shared/accountChoice";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as NodeOS from "node:os";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";

const DRIVERS = [ProviderDriverKind.make("claudeAgent"), ProviderDriverKind.make("codex")];

/**
 * How long an account waits after a ping before another. Usage snapshots
 * refresh every few minutes, so a ping whose new window has not shown up yet
 * must not be repeated every scheduler tick.
 */
export const KEEPALIVE_RETRY_MS = 10 * 60 * 1000;

function keepAliveAccountKey(provider: ServerProvider): string {
  const email = provider.auth.email?.trim().toLowerCase();
  const credential = provider.usageLimits?.credentialFingerprint;
  return `${provider.driver}:${email ?? (credential ? `credential:${credential}` : provider.instanceId)}`;
}

/** The instances to ping now: one per account whose session window is not running. */
export function dueKeepAlivePings(
  providers: ReadonlyArray<ServerProvider>,
  now: number,
  lastPingAt: ReadonlyMap<string, number>,
): ReadonlyArray<ServerProvider> {
  const due: ServerProvider[] = [];
  const seen = new Set<string>();
  for (const provider of DRIVERS.flatMap((driver) => usableInstances(providers, driver))) {
    const key = keepAliveAccountKey(provider);
    if (provider.auth.status !== "authenticated" || seen.has(key)) continue;
    seen.add(key);
    const session = provider.usageLimits?.windows.find((window) => window.kind === "session");
    if (!session || accountStanding(provider.usageLimits, now).limited) continue;
    const resetsAt = session.resetsAt === undefined ? Number.NaN : Date.parse(session.resetsAt);
    if (Number.isFinite(resetsAt) && resetsAt > now) continue;
    if (now - (lastPingAt.get(key) ?? -Infinity) < KEEPALIVE_RETRY_MS) continue;
    due.push(provider);
  }
  return due;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry;
    const settings = yield* ServerSettings.ServerSettingsService;
    const textGeneration = yield* TextGeneration;
    const scheduler = yield* Scheduler.Scheduler;
    const lastPingAt = yield* Ref.make(new Map<string, number>());

    const ping = Effect.fn("UsageWindowKeepAlive.ping")(function* (provider: ServerProvider) {
      const model = DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider.driver];
      if (!model) return;
      const key = keepAliveAccountKey(provider);
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(lastPingAt, (current) => new Map(current).set(key, now));
      yield* textGeneration
        .generateBranchName({
          cwd: NodeOS.tmpdir(),
          message: "hi",
          modelSelection: { instanceId: provider.instanceId, model },
        })
        .pipe(
          Effect.tap(() =>
            Effect.logInfo("usage-window-keepalive.pinged", { instanceId: provider.instanceId }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("usage-window-keepalive.ping-failed", {
              instanceId: provider.instanceId,
              cause,
            }),
          ),
        );
      // Read the window the ping opened, so the next tick sees it running.
      yield* providers.refreshInstance(provider.instanceId);
    });

    const sweep = Effect.gen(function* () {
      if (!(yield* settings.getSettings).keepUsageWindowsOpen) return;
      const due = dueKeepAlivePings(
        yield* providers.getProviders,
        yield* Clock.currentTimeMillis,
        yield* Ref.get(lastPingAt),
      );
      yield* Effect.forEach(due, ping, { discard: true, concurrency: "unbounded" });
    });

    yield* scheduler.register("usage-window-keepalive", sweep);
  }),
);

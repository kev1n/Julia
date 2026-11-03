/**
 * Fork: the fleet hub, held in memory on the hub server.
 * It is only an index: every server republishes its full snapshot each
 * heartbeat, so after a hub restart the index rebuilds within one heartbeat.
 * Environments that stop publishing are marked stale, never removed.
 */
import { STALE_AFTER_MS } from "./config.ts";
import { mergeSnapshot } from "./fleetIndex.ts";
import type { FleetEnvironmentEntry, FleetIndex, FleetSnapshot } from "./model.ts";

const entries = new Map<string, FleetEnvironmentEntry>();

export function hubPublish(
  snapshot: FleetSnapshot,
  now: number,
): { readonly accepted: boolean; readonly reason?: string } {
  const outcome = mergeSnapshot(entries.get(snapshot.environmentId), snapshot, now);
  if (!outcome.accepted) return { accepted: false, reason: outcome.reason };
  entries.set(snapshot.environmentId, outcome.entry);
  return { accepted: true };
}

export function hubIndex(now: number): FleetIndex {
  return { asOf: now, staleAfterMs: STALE_AFTER_MS, environments: [...entries.values()] };
}

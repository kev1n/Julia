/**
 * Fork: Usage > Machines cards (CPU, memory, disk) from each server's
 * `server.getHostResources`. The phone draws the same cards from this file
 * (apps/mobile/src/fork/machines.tsx), so it holds no React or atom state.
 */
import type { HostResourcesSnapshot } from "@t3tools/contracts";

export { machineSummary, offlineText } from "@t3tools/shared/machineCardsCopy";

/**
 * How often an open Machines view asks each connected server again: the
 * server caches its host snapshot for 5 seconds (`HostResources.ts`), so a
 * faster poll would only repeat the same numbers.
 */
export const MACHINES_POLL_MS = 5_000;

export interface MachineSource {
  /** The environment's connection is up. */
  readonly connected: boolean;
  /** The newest snapshot the client holds, even while a refresh is in flight. */
  readonly resources: HostResourcesSnapshot | null;
  /** The newest request failed (the server did not answer in time). */
  readonly failed: boolean;
}

export interface Meter {
  /** 0 to 100, rounded. */
  readonly percent: number;
  readonly detail: string;
  /** The same reading in a few characters, for one-line machine lists: `37%`, `24/32 GB`. */
  readonly short: string;
}

export type MachineCard =
  | {
      readonly kind: "online";
      readonly cpu: Meter | null;
      readonly memory: Meter;
      readonly disk: Meter | null;
    }
  | { readonly kind: "loading" }
  | { readonly kind: "offline"; readonly lastSeenAt: number | null };

const GIB = 1024 ** 3;
const GB = 1000 ** 3;

/**
 * `21.3 GB`, `1.5 TB`. Memory is counted in binary units and disk in decimal
 * ones, as macOS's own Activity Monitor and Finder do, so 32 GB of RAM reads
 * as 32 GB and a 1 TB SSD as 1 TB.
 */
export function formatSize(bytes: number, unit: "memory" | "disk"): string {
  const gigabyte = unit === "memory" ? GIB : GB;
  const kilo = unit === "memory" ? 1024 : 1000;
  const gigabytes = bytes / gigabyte;
  if (gigabytes >= kilo) return `${trim(gigabytes / kilo)} TB`;
  return `${trim(gigabytes)} GB`;
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function usedMeter(used: number, total: number, unit: "memory" | "disk"): Meter {
  const clamped = Math.min(total, Math.max(0, used));
  const usedText = formatSize(clamped, unit);
  const totalText = formatSize(total, unit);
  const [usedNumber, usedUnit] = usedText.split(" ");
  return {
    percent: total > 0 ? Math.round((clamped / total) * 100) : 0,
    detail: `${usedText} of ${totalText}`,
    // `24/32 GB`, or both units when they differ: `600 GB/1 TB`.
    short: totalText.endsWith(` ${usedUnit}`)
      ? `${usedNumber}/${totalText}`
      : `${usedText}/${totalText}`,
  };
}

/**
 * The card for one machine. It is offline while its connection is down or its
 * server stops answering; `rememberedLastSeenAt` is the newest snapshot time
 * this client saw earlier, kept across the view closing and reopening.
 */
export function machineCard(
  source: MachineSource,
  rememberedLastSeenAt: number | null,
): MachineCard {
  const { resources } = source;
  if (!source.connected || source.failed) {
    const lastSeenAt = Math.max(resources?.sampledAt ?? -1, rememberedLastSeenAt ?? -1);
    return { kind: "offline", lastSeenAt: lastSeenAt >= 0 ? lastSeenAt : null };
  }
  if (resources === null) return { kind: "loading" };
  const { totalDiskBytes, freeDiskBytes, cpuUtilization } = resources;
  const cpuPercent = cpuUtilization === null ? null : Math.round(cpuUtilization * 100);
  return {
    kind: "online",
    cpu:
      cpuPercent === null
        ? null
        : { percent: cpuPercent, detail: `${resources.cpuCount} cores`, short: `${cpuPercent}%` },
    memory: usedMeter(
      resources.totalMemoryBytes - resources.availableMemoryBytes,
      resources.totalMemoryBytes,
      "memory",
    ),
    disk:
      totalDiskBytes === undefined || freeDiskBytes === undefined
        ? null
        : usedMeter(totalDiskBytes - freeDiskBytes, totalDiskBytes, "disk"),
  };
}

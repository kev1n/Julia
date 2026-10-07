/**
 * Fork (Owner): Usage > Machines cards (CPU, memory, disk) from each server's
 * `server.getHostResources`. The phone draws the same cards from this file
 * (apps/mobile/src/fork/machines.tsx), so it holds no React or atom state.
 */
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimits";

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
  return {
    percent: total > 0 ? Math.round((clamped / total) * 100) : 0,
    detail: `${formatSize(clamped, unit)} of ${formatSize(total, unit)}`,
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
  const { totalDiskBytes, freeDiskBytes } = resources;
  return {
    kind: "online",
    cpu:
      resources.cpuUtilization === null
        ? null
        : {
            percent: Math.round(resources.cpuUtilization * 100),
            detail: `${resources.cpuCount} cores`,
          },
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

/** `Offline · last seen 12m ago`, from the server's own snapshot time. */
export function offlineText(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt === null) return "Offline · not seen since the app opened";
  const ago = now - lastSeenAt;
  return ago < 60_000
    ? "Offline · last seen just now"
    : `Offline · last seen ${formatDuration(ago)} ago`;
}

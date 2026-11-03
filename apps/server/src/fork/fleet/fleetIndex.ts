// @effect-diagnostics globalDate:off
/**
 * Fork: the hub's merge and the overlap rule, pure so they can be
 * tested without servers.
 */
import type {
  FleetCheckout,
  FleetCoverage,
  FleetEnvironmentEntry,
  FleetIntent,
  FleetPathChange,
  FleetSnapshot,
  FleetThread,
} from "./model.ts";

export type MergeOutcome =
  | { readonly accepted: true; readonly entry: FleetEnvironmentEntry }
  | { readonly accepted: false; readonly reason: string };

function keepLastGoodScan(previous: FleetCheckout | undefined, next: FleetCheckout): FleetCheckout {
  if (next.scanError === undefined || previous === undefined || previous.scannedAt === null) {
    return next;
  }
  return { ...previous, scanError: next.scanError };
}

/**
 * Merges one environment's snapshot: older or repeated snapshots of an incarnation are ignored; a
 * complete snapshot replaces the environment's records, an incomplete one only adds and updates;
 * a checkout whose scan failed keeps its last good evidence.
 */
export function mergeSnapshot(
  previous: FleetEnvironmentEntry | undefined,
  next: FleetSnapshot,
  now: number,
): MergeOutcome {
  if (
    previous !== undefined &&
    previous.snapshot.incarnation === next.incarnation &&
    next.seq <= previous.snapshot.seq
  ) {
    return { accepted: false, reason: "out-of-order snapshot" };
  }
  const previousCheckouts = new Map(
    (previous?.snapshot.checkouts ?? []).map((checkout) => [checkout.key, checkout]),
  );
  const checkouts = next.checkouts.map((checkout) =>
    keepLastGoodScan(previousCheckouts.get(checkout.key), checkout),
  );
  if (next.complete || previous === undefined) {
    return { accepted: true, entry: { snapshot: { ...next, checkouts }, receivedAt: now } };
  }
  const threads = new Map(previous.snapshot.threads.map((thread) => [thread.threadId, thread]));
  for (const thread of next.threads) threads.set(thread.threadId, thread);
  const merged = new Map(previous.snapshot.checkouts.map((checkout) => [checkout.key, checkout]));
  for (const checkout of checkouts) merged.set(checkout.key, checkout);
  return {
    accepted: true,
    entry: {
      snapshot: {
        ...next,
        lastScanAt: next.lastScanAt ?? previous.snapshot.lastScanAt,
        threads: [...threads.values()],
        checkouts: [...merged.values()],
      },
      receivedAt: now,
    },
  };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Stale when the heartbeat is older than `staleAfterMs`; records are kept, never dropped. */
export function coverageOf(
  entries: ReadonlyArray<FleetEnvironmentEntry>,
  now: number,
  staleAfterMs: number,
): ReadonlyArray<FleetCoverage> {
  return entries.map(({ snapshot, receivedAt }) => ({
    environmentId: snapshot.environmentId,
    label: snapshot.label,
    status: now - receivedAt > staleAfterMs ? "stale" : "fresh",
    heartbeatAt: iso(receivedAt),
    lastScanAt: iso(snapshot.lastScanAt),
    threadCount: snapshot.threads.length,
  }));
}

export const isActive = (thread: FleetThread) =>
  thread.lifecycle === "running" || thread.lifecycle === "idle";

export type FleetEvidence =
  | {
      readonly source: "observed";
      readonly kind: FleetPathChange["kind"];
      readonly change: FleetPathChange["change"];
    }
  | { readonly source: "declared"; readonly key: string; readonly access: FleetIntent["access"] };

interface Touch {
  readonly key: string;
  readonly evidence: FleetEvidence;
}

function touchesOf(thread: FleetThread, checkout: FleetCheckout | undefined): ReadonlyArray<Touch> {
  const observed = (checkout?.changes ?? []).flatMap((change): Touch[] => {
    const evidence: FleetEvidence = {
      source: "observed",
      kind: change.kind,
      change: change.change,
    };
    return change.from === undefined
      ? [{ key: change.path, evidence }]
      : [
          { key: change.path, evidence },
          { key: change.from, evidence },
        ];
  });
  const declared = thread.intents.map((intent) => ({
    key: intent.key,
    evidence: { source: "declared", key: intent.key, access: intent.access } as const,
  }));
  return [...observed, ...declared];
}

/** Equal paths, or a directory key (`dir/`) that contains the other. Returns the narrower path. */
export function matchKeys(left: string, right: string): string | null {
  if (left === right) return left;
  if (left.endsWith("/") && right.startsWith(left)) return right;
  if (right.endsWith("/") && left.startsWith(right)) return left;
  return null;
}

const writes = (evidence: FleetEvidence) =>
  evidence.source === "observed" || evidence.access === "write";

export interface FleetOverlapPath {
  readonly path: string;
  readonly conflict: "write/write" | "read/write" | "read/read";
  readonly mine: ReadonlyArray<FleetEvidence>;
  readonly theirs: ReadonlyArray<FleetEvidence>;
}

export interface FleetOverlap {
  readonly thread: FleetThread;
  readonly environmentLabel: string;
  readonly stale: boolean;
  /** Both threads run in the same checkout, so every change there is shared. */
  readonly sharedCheckout: boolean;
  readonly paths: ReadonlyArray<FleetOverlapPath>;
}

/**
 * Other active threads in the same repository whose observed changes or
 * declared intents touch the same paths as `me` (or share its checkout).
 * Settled and archived threads are not members of any overlap.
 */
export function findOverlaps(input: {
  readonly me: FleetThread;
  readonly myCheckout: FleetCheckout | undefined;
  readonly extraKeys?: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<FleetEnvironmentEntry>;
  readonly now: number;
  readonly staleAfterMs: number;
}): ReadonlyArray<FleetOverlap> {
  const { me } = input;
  const mine: Touch[] = [
    ...touchesOf(me, input.myCheckout),
    ...(input.extraKeys ?? []).map((key) => ({
      key,
      evidence: { source: "declared", key, access: "read" } as const,
    })),
  ];
  const overlaps: FleetOverlap[] = [];
  for (const { snapshot, receivedAt } of input.entries) {
    const checkouts = new Map(snapshot.checkouts.map((checkout) => [checkout.key, checkout]));
    for (const other of snapshot.threads) {
      if (other.environmentId === me.environmentId && other.threadId === me.threadId) continue;
      if (!isActive(other) || me.repoKey === null || other.repoKey !== me.repoKey) continue;
      const sharedCheckout = me.checkoutKey !== null && other.checkoutKey === me.checkoutKey;
      const theirs = touchesOf(
        other,
        other.checkoutKey === null ? undefined : checkouts.get(other.checkoutKey),
      );
      const byPath = new Map<string, { mine: FleetEvidence[]; theirs: FleetEvidence[] }>();
      for (const a of mine) {
        for (const b of theirs) {
          const path = matchKeys(a.key, b.key);
          if (path === null) continue;
          const slot = byPath.get(path) ?? { mine: [], theirs: [] };
          if (!slot.mine.includes(a.evidence)) slot.mine.push(a.evidence);
          if (!slot.theirs.includes(b.evidence)) slot.theirs.push(b.evidence);
          byPath.set(path, slot);
        }
      }
      if (!sharedCheckout && byPath.size === 0) continue;
      const paths = [...byPath].map(([path, slot]): FleetOverlapPath => {
        const left = slot.mine.some(writes);
        const right = slot.theirs.some(writes);
        return {
          path,
          conflict: left && right ? "write/write" : left || right ? "read/write" : "read/read",
          mine: slot.mine,
          theirs: slot.theirs,
        };
      });
      paths.sort((a, b) => a.path.localeCompare(b.path));
      overlaps.push({
        thread: other,
        environmentLabel: snapshot.label,
        stale: input.now - receivedAt > input.staleAfterMs,
        sharedCheckout,
        paths,
      });
    }
  }
  const writeWrite = (overlap: FleetOverlap) =>
    overlap.paths.filter((path) => path.conflict === "write/write").length;
  // Shared checkouts first, then the most write/write paths.
  return overlaps.sort(
    (a, b) => Number(b.sharedCheckout) - Number(a.sharedCheckout) || writeWrite(b) - writeWrite(a),
  );
}

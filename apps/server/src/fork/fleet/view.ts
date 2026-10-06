// @effect-diagnostics globalDate:off
/**
 * Fork (Owner): the fleet as one server's tools see it: the hub's index with
 * this server's own, fresher snapshot substituted. Without the hub, the
 * answer degrades to this server plus the last index it saw, marked as such.
 */
import { STALE_AFTER_MS, fleetRequest, type FleetConfig } from "./config.ts";
import { coverageOf } from "./fleetIndex.ts";
import type { FleetCoverage, FleetEnvironmentEntry, FleetIndex, FleetSnapshot } from "./model.ts";
import { acmePathMeaning } from "./acmePaths.ts";
import type { FleetOverlap } from "./fleetIndex.ts";
import type { FleetOverlapOut, FleetThreadSummary } from "./tools.ts";
import type { FleetThread } from "./model.ts";

let lastIndex: FleetIndex | null = null;

export interface FleetView {
  readonly asOf: string;
  readonly now: number;
  readonly hub: "reachable" | "unreachable" | "not-configured";
  readonly entries: ReadonlyArray<FleetEnvironmentEntry>;
  readonly coverage: ReadonlyArray<FleetCoverage>;
}

export async function loadView(
  config: FleetConfig | null,
  local: FleetSnapshot | null,
): Promise<FleetView> {
  const now = Date.now();
  if (config === null) {
    return {
      asOf: new Date(now).toISOString(),
      now,
      hub: "not-configured",
      entries: [],
      coverage: [],
    };
  }
  const withLocal = (entries: ReadonlyArray<FleetEnvironmentEntry>, at: number) => {
    if (local === null) return entries;
    const others = entries.filter((entry) => entry.snapshot.environmentId !== local.environmentId);
    return [{ snapshot: local, receivedAt: at }, ...others];
  };
  try {
    const index = (await fleetRequest(
      config,
      `${config.hubUrl}/fork/fleet/hub/index`,
    )) as FleetIndex;
    lastIndex = index;
    const entries = withLocal(index.environments, index.asOf);
    return {
      asOf: new Date(index.asOf).toISOString(),
      now: index.asOf,
      hub: "reachable",
      entries,
      coverage: coverageOf(entries, index.asOf, index.staleAfterMs),
    };
  } catch (error) {
    const previous = (lastIndex?.environments ?? []).filter(
      (entry) => entry.snapshot.environmentId !== local?.environmentId,
    );
    const entries = withLocal(previous, now);
    const note = `hub unreachable (${error instanceof Error ? error.message : String(error)})`;
    const coverage = coverageOf(entries, now, STALE_AFTER_MS).map((row): FleetCoverage =>
      row.environmentId === local?.environmentId
        ? row
        : { ...row, status: "unreachable", note: `${note}; last heartbeat shown` },
    );
    return { asOf: new Date(now).toISOString(), now, hub: "unreachable", entries, coverage };
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function summarize(view: FleetView, thread: FleetThread): FleetThreadSummary {
  const entry = view.entries.find(
    (candidate) => candidate.snapshot.environmentId === thread.environmentId,
  );
  const checkout =
    thread.checkoutKey === null
      ? undefined
      : entry?.snapshot.checkouts.find((candidate) => candidate.key === thread.checkoutKey);
  const coverage = view.coverage.find((row) => row.environmentId === thread.environmentId);
  return {
    environmentId: thread.environmentId,
    machine: entry?.snapshot.label ?? thread.environmentId,
    threadId: thread.threadId,
    title: thread.title,
    lifecycle: thread.lifecycle,
    repo: thread.repoKey,
    branch: thread.branch,
    checkout: checkout?.path ?? null,
    changedPaths: new Set(checkout?.changes.map((change) => change.path) ?? []).size,
    intents: thread.intents,
    lastActivityAt: iso(thread.lastActivityAt),
    stale: coverage === undefined || coverage.status !== "fresh",
  };
}

export function overlapOut(view: FleetView, overlap: FleetOverlap): FleetOverlapOut {
  return {
    thread: summarize(view, overlap.thread),
    sharedCheckout: overlap.sharedCheckout,
    paths: overlap.paths.map((path) => {
      const meaning = acmePathMeaning(overlap.thread.repoKey, path.path);
      return {
        path: path.path,
        conflict: path.conflict,
        mine: path.mine.map((evidence) => ({ ...evidence })),
        theirs: path.theirs.map((evidence) => ({ ...evidence })),
        ...(meaning?.sku === undefined ? {} : { sku: meaning.sku }),
        ...(meaning?.provider === undefined ? {} : { provider: meaning.provider }),
      };
    }),
  };
}

/**
 * Fork (Owner): fleet records. Every server publishes a snapshot to the hub, which keeps the latest
 * per environment and never invents or deletes on absence. Declared intent, observed changes,
 * lifecycle and freshness (heartbeat, scan, activity) stay separate on purpose.
 */
import * as Schema from "effect/Schema";

export const FleetLifecycle = Schema.Literals(["running", "idle", "settled", "archived"]);
export type FleetLifecycle = typeof FleetLifecycle.Type;

/** Where an observed path change sits relative to the checkout's base. */
export const FleetChangeKind = Schema.Literals(["committed", "staged", "unstaged", "untracked"]);
export type FleetChangeKind = typeof FleetChangeKind.Type;

export const FleetPathChange = Schema.Struct({
  /** Repository-relative, forward slashes. */
  path: Schema.String,
  kind: FleetChangeKind,
  /** A added, M modified, D deleted, R renamed (from `from`), T type change, U unmerged. */
  change: Schema.Literals(["A", "M", "D", "R", "T", "U"]),
  from: Schema.optional(Schema.String),
});
export type FleetPathChange = typeof FleetPathChange.Type;

export const FleetCheckout = Schema.Struct({
  /** `<environmentId>:<absolute path>`; threads sharing a checkout share this key. */
  key: Schema.String,
  path: Schema.String,
  repoKey: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  /** The ref the branch is measured against (the default branch, or the branch it is stacked on). */
  base: Schema.NullOr(Schema.Struct({ ref: Schema.String, sha: Schema.String })),
  changes: Schema.Array(FleetPathChange),
  /** Epoch ms of the last successful scan; null before the first. */
  scannedAt: Schema.NullOr(Schema.Number),
  /** Set when the latest scan failed; `changes` then holds the last good scan. */
  scanError: Schema.optional(Schema.String),
});
export type FleetCheckout = typeof FleetCheckout.Type;

export const FleetIntent = Schema.Struct({
  /** Repository-relative path; a trailing `/` covers everything below it. */
  key: Schema.String,
  access: Schema.Literals(["read", "write"]),
  note: Schema.optional(Schema.String),
});
export type FleetIntent = typeof FleetIntent.Type;

export const FleetThread = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  repoKey: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  checkoutKey: Schema.NullOr(Schema.String),
  lifecycle: FleetLifecycle,
  runtimeMode: Schema.String,
  providerInstanceId: Schema.String,
  model: Schema.String,
  /** Epoch ms of the thread's last activity (run start/finish, message). */
  lastActivityAt: Schema.NullOr(Schema.Number),
  intents: Schema.Array(FleetIntent),
  intentsAt: Schema.NullOr(Schema.Number),
  /** Bounded user goals and recent agent findings; absent on older servers. */
  workContext: Schema.optional(Schema.String),
});
export type FleetThread = typeof FleetThread.Type;

export const FleetSnapshot = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  /** Where peers reach this server (tailnet URL). */
  baseUrl: Schema.String,
  /** Random per server process; a new one means the server restarted. */
  incarnation: Schema.String,
  /** Increases with every snapshot from one incarnation. */
  seq: Schema.Number,
  /** False when the server could not read all of its own state; the hub then only adds. */
  complete: Schema.Boolean,
  lastScanAt: Schema.NullOr(Schema.Number),
  threads: Schema.Array(FleetThread),
  checkouts: Schema.Array(FleetCheckout),
});
export type FleetSnapshot = typeof FleetSnapshot.Type;

/** One environment as the hub holds it. `receivedAt` is the heartbeat clock (hub time). */
export const FleetEnvironmentEntry = Schema.Struct({
  snapshot: FleetSnapshot,
  receivedAt: Schema.Number,
});
export type FleetEnvironmentEntry = typeof FleetEnvironmentEntry.Type;

export const FleetIndex = Schema.Struct({
  /** Hub clock when the index was read. */
  asOf: Schema.Number,
  /** Heartbeat age after which an environment's records are stale (ms). */
  staleAfterMs: Schema.Number,
  environments: Schema.Array(FleetEnvironmentEntry),
});
export type FleetIndex = typeof FleetIndex.Type;

/** Per-environment coverage on every tool response, so "no matches" never hides a machine. */
export const FleetCoverage = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["fresh", "stale", "unreachable"]),
  heartbeatAt: Schema.NullOr(Schema.String),
  lastScanAt: Schema.NullOr(Schema.String),
  threadCount: Schema.Number,
  note: Schema.optional(Schema.String),
});
export type FleetCoverage = typeof FleetCoverage.Type;

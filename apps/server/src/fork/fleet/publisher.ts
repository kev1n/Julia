// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork (Owner): publishes this server's threads and checkouts to the hub. Snapshots are rebuilt
 * from projections, never the live-tail event stream, so a restart publishes a full snapshot under
 * a new incarnation; events only trigger a republish. A failed publish waits for the heartbeat.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { repositoryGroupingKeyOf } from "@t3tools/contracts";
import {
  FleetOperationError,
  HEARTBEAT_MS,
  fleetRequest,
  readFleetConfig,
  type FleetConfig,
} from "./config.ts";
import { forgetCheckoutsExcept, scanCheckout } from "./gitScan.ts";
import { workContext } from "./workContext.ts";
import type {
  FleetCheckout,
  FleetIntent,
  FleetLifecycle,
  FleetSnapshot,
  FleetThread,
} from "./model.ts";

const incarnation = NodeCrypto.randomUUID();
let seq = 0;
let config: FleetConfig | null = null;
let latest: FleetSnapshot | null = null;
const checkoutScans = new Map<string, FleetCheckout>();
const contexts = new Map<string, { key: string; text: string }>();
let lastScanAt: number | null = null;
let intents = new Map<
  string,
  { readonly intents: ReadonlyArray<FleetIntent>; readonly at: number }
>();
let wake: (() => void) | null = null;
/** Captured when the publisher starts, so tools can refresh without the services in scope. */
let deps: {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly resolver: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
} | null = null;
/** An event arrived since the loop last looked. */
let dirty = false;

export const fleetConfig = () => config;
/** This server's latest snapshot, for tools answering locally. */
export const localSnapshot = () => latest;

const millis = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

export function lifecycleOf(shell: OrchestrationV2ThreadShell): FleetLifecycle {
  if (shell.archivedAt !== null) return "archived";
  if (
    shell.settledOverride === "settled" ||
    (shell.settledAt !== null && shell.settledOverride !== "active")
  ) {
    return "settled";
  }
  return shell.activeRunId !== null ? "running" : "idle";
}

function intentsPath() {
  return NodePath.join(config!.userdataDir, "fork-fleet-intents.json");
}

function loadIntents() {
  try {
    const raw = JSON.parse(NodeFS.readFileSync(intentsPath(), "utf8")) as Record<
      string,
      { intents: FleetIntent[]; at: number }
    >;
    intents = new Map(Object.entries(raw));
  } catch {
    intents = new Map();
  }
}

function saveIntents() {
  const temporary = `${intentsPath()}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify(Object.fromEntries(intents)), { mode: 0o600 });
  NodeFS.renameSync(temporary, intentsPath());
}

/** Replace a thread's declared intents (t3_work_publish). */
export function setIntents(threadId: string, next: ReadonlyArray<FleetIntent>, now: number) {
  if (next.length === 0) intents.delete(threadId);
  else intents.set(threadId, { intents: next, at: now });
  saveIntents();
}

/**
 * Events that can change a thread's lifecycle, branch or checkout. Message
 * and turn-item updates stream during a turn and are left to the heartbeat.
 */
const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  "run.created",
  "run.updated",
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.metadata-updated",
]);

/** A checkout's repository does not change; resolving it can be slow (remote lookups). */
const repoKeyCache = new Map<string, string>();

const checkoutKeyOf = (environmentId: string, path: string) => `${environmentId}:${path}`;

/**
 * Rebuild the snapshot from this server's projections. `scan` lists the
 * checkouts to rescan now; others keep their last scan.
 */
const buildSnapshot = Effect.fn("fork.fleet.buildSnapshot")(function* (input: {
  readonly scan: "active" | ReadonlySet<string>;
}) {
  const { orchestrator, projects, resolver, environment } = deps!;
  const descriptor = yield* environment.getDescriptor;
  const environmentId = descriptor.environmentId;
  let complete = true;
  const [active, archive, projectShells] = yield* Effect.all([
    orchestrator.getShellSnapshot({ location: "active" }),
    orchestrator.getShellSnapshot({ location: "archive" }),
    projects.listShells(),
  ]).pipe(
    Effect.catch(() => {
      complete = false;
      return Effect.succeed([{ threads: [] }, { threads: [] }, []] as const);
    }),
  );
  const roots = new Map(projectShells.map((project) => [project.id, project.workspaceRoot]));
  const shells = [...active.threads, ...archive.threads].filter(
    (shell) => shell.deletedAt === null && shell.lineage.relationshipToParent !== "subagent",
  );
  const threads: FleetThread[] = [];
  const activePaths = new Set<string>();
  const repoKeys = repoKeyCache;
  for (const shell of shells) {
    const path = shell.worktreePath ?? roots.get(shell.projectId) ?? null;
    const lifecycle = lifecycleOf(shell);
    // Archived threads keep whatever was resolved; a missing identity is retried
    // (a new worktree may not be a git checkout yet).
    if (path !== null && !repoKeys.has(path) && lifecycle !== "archived") {
      const identity = yield* resolver
        .resolve(path)
        .pipe(Effect.timeoutOption(HEARTBEAT_MS), Effect.map(Option.getOrNull));
      if (identity !== null) repoKeys.set(path, repositoryGroupingKeyOf(identity));
    }
    // Only git checkouts have evidence to scan; a scratch folder has none.
    if (path !== null && repoKeys.has(path) && (lifecycle === "running" || lifecycle === "idle")) {
      activePaths.add(path);
    }
    const declared = intents.get(shell.id);
    // Only read goals when activity changes, plus once a minute while running.
    // User messages are sparse; agent messages are restricted to the latest run.
    const contextKey = `${shell.latestUserMessageAt}:${shell.latestRunId}:${shell.latestRunCompletedAt}:${lifecycle === "running" ? Math.floor(Date.now() / 60_000) : ""}`;
    if (
      (lifecycle === "running" || lifecycle === "idle") &&
      contexts.get(shell.id)?.key !== contextKey
    ) {
      const runId = shell.activeRunId ?? shell.latestRunId;
      const context = yield* Effect.all([
        orchestrator.getThreadRecords(shell.id, ["messages"], { messageRoles: ["user"] }),
        runId === null
          ? Effect.succeed({ messages: [] })
          : orchestrator.getThreadRecords(shell.id, ["messages"], {
              messageRoles: ["assistant"],
              messageRunIds: [runId],
            }),
      ]).pipe(
        Effect.map(([users, agent]) => workContext(users.messages, agent.messages)),
        Effect.orElseSucceed(() => contexts.get(shell.id)?.text ?? ""),
      );
      contexts.set(shell.id, { key: contextKey, text: context });
    }
    const times = [
      millis(shell.latestRunStartedAt),
      millis(shell.latestRunCompletedAt),
      millis(shell.latestUserMessageAt),
    ].filter((value): value is number => value !== null);
    threads.push({
      environmentId,
      threadId: shell.id,
      title: shell.title,
      projectId: shell.projectId,
      repoKey: path === null ? null : (repoKeys.get(path) ?? null),
      branch: shell.branch,
      checkoutKey: path === null ? null : checkoutKeyOf(environmentId, path),
      lifecycle,
      runtimeMode: shell.runtimeMode,
      providerInstanceId: shell.providerInstanceId,
      model: shell.modelSelection.model,
      lastActivityAt: times.length === 0 ? null : Math.max(...times),
      intents: declared?.intents ?? [],
      intentsAt: declared?.at ?? null,
      workContext: contexts.get(shell.id)?.text ?? "",
    });
  }
  // Only checkouts of active threads are published; a removed worktree drops out.
  const activeThreadIds = new Set(
    threads
      .filter((thread) => thread.lifecycle === "running" || thread.lifecycle === "idle")
      .map((thread) => thread.threadId),
  );
  for (const id of contexts.keys()) if (!activeThreadIds.has(id)) contexts.delete(id);
  // Deleting while iterating a Map is safe: visited entries are skipped.
  for (const path of checkoutScans.keys()) {
    if (!activePaths.has(path) || !NodeFS.existsSync(path)) checkoutScans.delete(path);
  }
  forgetCheckoutsExcept(activePaths);
  for (const path of activePaths) {
    if (!NodeFS.existsSync(path)) continue;
    const previous = checkoutScans.get(path);
    if (previous !== undefined && input.scan !== "active" && !input.scan.has(path)) continue;
    const scanned = yield* Effect.tryPromise({
      try: () => scanCheckout(path),
      catch: (cause) => new FleetOperationError({ cause }),
    }).pipe(Effect.result);
    const now = Date.now();
    const base = {
      key: checkoutKeyOf(environmentId, path),
      path,
      repoKey: repoKeys.get(path) ?? null,
    };
    if (scanned._tag === "Success") {
      checkoutScans.set(path, {
        ...base,
        ...scanned.success,
        changes: [...scanned.success.changes],
        scannedAt: now,
      });
      lastScanAt = now;
    } else {
      checkoutScans.set(path, {
        ...(previous ?? {
          ...base,
          branch: null,
          head: null,
          base: null,
          changes: [],
          scannedAt: null,
        }),
        scanError: String(scanned.failure).slice(0, 300),
      });
    }
  }
  seq += 1;
  return {
    environmentId,
    label: descriptor.label,
    baseUrl: config!.selfUrl,
    incarnation,
    seq,
    complete,
    lastScanAt,
    threads,
    checkouts: [...checkoutScans.values()],
  } satisfies FleetSnapshot;
});

const lifecycleKey = (snapshot: FleetSnapshot) =>
  snapshot.threads
    .map((thread) => `${thread.threadId}:${thread.lifecycle}:${thread.intentsAt ?? ""}`)
    .sort()
    .join("|");

const publish = (snapshot: FleetSnapshot) =>
  Effect.tryPromise({
    try: () => fleetRequest(config!, `${config!.hubUrl}/fork/fleet/hub/publish`, snapshot),
    catch: (cause) => new FleetOperationError({ cause }),
  }).pipe(
    Effect.catch((error) => Effect.logDebug("fleet publish failed", { error: String(error) })),
  );

/**
 * Look again now and publish: rescans the given checkouts (or all active
 * ones) first. Used by the tools so an answer reflects the caller's latest
 * edits, and by the loop.
 */
export const refreshNow = Effect.fn("fork.fleet.refreshNow")(function* (
  scan: "active" | ReadonlySet<string> = "active",
) {
  if (config === null || deps === null) return null;
  const snapshot = yield* buildSnapshot({ scan });
  latest = snapshot;
  yield* publish(snapshot);
  return snapshot;
});

/** The background loop, forked for the server's lifetime. */
export const runPublisher = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  config = readFleetConfig(NodePath.dirname(serverConfig.environmentIdPath));
  if (config === null) return;
  // Optional, so test servers built without these stores simply run without the fleet.
  const [orchestratorOption, projectsOption, resolverOption] = yield* Effect.all([
    Effect.serviceOption(Orchestrator.OrchestratorV2),
    Effect.serviceOption(ProjectStore.ProjectStoreV2),
    Effect.serviceOption(RepositoryIdentityResolver.RepositoryIdentityResolver),
  ]);
  if (
    Option.isNone(orchestratorOption) ||
    Option.isNone(projectsOption) ||
    Option.isNone(resolverOption)
  ) {
    return;
  }
  const orchestrator = orchestratorOption.value;
  deps = {
    orchestrator,
    projects: projectsOption.value,
    resolver: resolverOption.value,
    environment: yield* ServerEnvironment.ServerEnvironment,
  };
  loadIntents();
  // Subscribe before the first full build, so nothing between them is missed.
  yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter((event) => LIFECYCLE_EVENTS.has(event.type)),
    Stream.runForEach(() =>
      Effect.sync(() => {
        dirty = true;
        wake?.();
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  let lastHeartbeat = 0;
  let previousLifecycle = "";
  while (true) {
    dirty = false;
    const now = Date.now();
    const heartbeatDue = now - lastHeartbeat >= HEARTBEAT_MS;
    const snapshot = yield* buildSnapshot({ scan: heartbeatDue ? "active" : new Set() }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("fleet snapshot failed", { cause }).pipe(Effect.as(null)),
      ),
    );
    if (snapshot !== null) {
      const key = lifecycleKey(snapshot);
      // A turn ended or started: rescan the checkouts of threads that changed state.
      if (!heartbeatDue && key !== previousLifecycle && latest !== null) {
        const before = new Map(latest.threads.map((thread) => [thread.threadId, thread.lifecycle]));
        const changed = new Set(
          snapshot.threads
            .filter((thread) => before.get(thread.threadId) !== thread.lifecycle)
            .flatMap((thread) =>
              thread.checkoutKey === null
                ? []
                : [thread.checkoutKey.slice(thread.environmentId.length + 1)],
            ),
        );
        const rescanned = yield* buildSnapshot({ scan: changed }).pipe(
          Effect.orElseSucceed(() => snapshot),
        );
        latest = rescanned;
      } else {
        latest = snapshot;
      }
      if (heartbeatDue || key !== previousLifecycle) {
        yield* publish(latest);
        lastHeartbeat = now;
        previousLifecycle = key;
      }
    }
    // Sleep until the next heartbeat or the next domain event, whichever is first.
    if (dirty) continue;
    yield* Effect.callback<void>((resume) => {
      const timer = setTimeout(
        () => resume(Effect.void),
        Math.max(0, HEARTBEAT_MS - (Date.now() - lastHeartbeat)),
      );
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resume(Effect.void);
      };
      return Effect.sync(() => clearTimeout(timer));
    });
  }
});

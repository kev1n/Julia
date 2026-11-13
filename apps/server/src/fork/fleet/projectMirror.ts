// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: projects created or deleted on one fleet machine follow on the others, matched by repository
 * (a project with no remote is first published as a private GitHub repo). State persists in
 * `fork-project-mirror.json`; this module's own commands carry `fleet-mirror:` ids and never echo.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  OrchestrationDispatchCommandError,
  OrchestratorMcpFailure,
  ProjectId,
  SourceControlProviderKind,
  repositoryGroupingKeyOf,
  type ApplicationStoredEvent,
  type OrchestrationProjectShell,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import { FleetOperationError, fleetRequest } from "./config.ts";
import { fleetConfig, localSnapshot } from "./publisher.ts";
import { loadView } from "./view.ts";

const COMMAND_PREFIX = "fleet-mirror:";
/** A project whose clone never finishes, or a machine that never comes back, is given up on. */
const SOURCE_TTL_MS = 24 * 60 * 60 * 1_000;
const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_FOLDER_ATTEMPTS = 9;

export const isMirrorCommand = (commandId: string | null) =>
  commandId !== null && commandId.startsWith(COMMAND_PREFIX);

const mirrorCommand = (kind: string, projectId: string) =>
  CommandId.make(`${COMMAND_PREFIX}${kind}:${projectId}`);

const fail = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

// ── Outbox ──────────────────────────────────────────────────────────────

/** What one machine is asked to do for one repository. */
export type MirrorRequest =
  | {
      readonly action: "create";
      readonly repoKey: string;
      readonly remoteUrl: string;
      readonly title: string;
      readonly createdAt: number;
    }
  | { readonly action: "delete"; readonly repoKey: string; readonly createdAt: number };

export type MirrorDelivery = MirrorRequest & { readonly environmentId: string };

export interface MirrorState {
  /** The last application event handled; null until the first start, which skips history. */
  readonly cursor: number | null;
  /** Projects created here that still need a finished clone or a remote before they go out. */
  readonly sources: Readonly<Record<string, { readonly createdAt: number }>>;
  /** One request per machine and repository; a later create or delete replaces an earlier one. */
  readonly deliveries: Readonly<Record<string, MirrorDelivery>>;
}

const EMPTY_STATE: MirrorState = { cursor: null, sources: {}, deliveries: {} };

const statePath = (userdataDir: string) => NodePath.join(userdataDir, "fork-project-mirror.json");

function readState(userdataDir: string): MirrorState {
  try {
    return {
      ...EMPTY_STATE,
      ...(JSON.parse(NodeFS.readFileSync(statePath(userdataDir), "utf8")) as Partial<MirrorState>),
    };
  } catch {
    return EMPTY_STATE;
  }
}

function writeState(userdataDir: string, state: MirrorState) {
  const path = statePath(userdataDir);
  NodeFS.writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
  NodeFS.renameSync(`${path}.tmp`, path);
}

/** Queues `delivery` for every machine in `environmentIds`, replacing what each had for the repository. */
export function enqueue(
  state: MirrorState,
  environmentIds: ReadonlyArray<string>,
  delivery: MirrorRequest,
): MirrorState {
  const deliveries = { ...state.deliveries };
  for (const environmentId of environmentIds) {
    deliveries[`${environmentId} ${delivery.repoKey}`] = { ...delivery, environmentId };
  }
  return { ...state, deliveries };
}

// ── Pure helpers ────────────────────────────────────────────────────────

/** The folder name `git clone` would pick for `remoteUrl`. */
function cloneFolderName(remoteUrl: string): string {
  const last =
    remoteUrl
      .split(/[?#]/)[0]!
      .split(/[/\\:]+/)
      .findLast((segment) => segment.trim().length > 0) ?? "";
  const name = last.endsWith(".git") ? last.slice(0, -".git".length) : last;
  return name.length > 0 ? name : "project";
}

/** `name`, then `name-2`, `name-3`… under `base`, as candidate clone folders. */
export function cloneFolderCandidates(base: string, remoteUrl: string): ReadonlyArray<string> {
  const name = cloneFolderName(remoteUrl);
  const root = base.replace(/[\\/]+$/, "") || "~";
  return Array.from(
    { length: MAX_FOLDER_ATTEMPTS },
    (_, index) => `${root}/${index === 0 ? name : `${name}-${index + 1}`}`,
  );
}

const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? NodePath.join(NodeOS.homedir(), path.slice(1)) : path;

/** Something other than an empty folder is at `path`. */
function isOccupied(path: string): boolean {
  try {
    return NodeFS.readdirSync(expandHome(path)).length > 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

const remoteUrlOf = (identity: RepositoryIdentity) =>
  identity.origin?.remoteUrl ?? identity.locator.remoteUrl;

type ProjectLifecycleEvent = Extract<
  ApplicationStoredEvent,
  { readonly type: "project.created" | "project.deleted" }
>;

const isProjectLifecycleEvent = (event: ApplicationStoredEvent): event is ProjectLifecycleEvent =>
  "type" in event && (event.type === "project.created" || event.type === "project.deleted");

const repoKeyOf = (shell: OrchestrationProjectShell) =>
  shell.repositoryIdentity ? repositoryGroupingKeyOf(shell.repositoryIdentity) : null;

// ── Wire ────────────────────────────────────────────────────────────────

const PeerMirror = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    machine: Schema.String,
    repoKey: Schema.String,
    remoteUrl: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("delete"),
    machine: Schema.String,
    repoKey: Schema.String,
  }),
]);
const decodePeerMirror = Schema.decodeUnknownEffect(PeerMirror);

type PeerReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly failure: { readonly code: string; readonly message: string } };

// ── Shared services ─────────────────────────────────────────────────────

const services = Effect.gen(function* () {
  return {
    projects: yield* ProjectService.ProjectService,
    clones: yield* ProjectCloneTracker.ProjectCloneTracker,
    resolver: yield* RepositoryIdentityResolver.RepositoryIdentityResolver,
    enrichment: yield* ProjectEnrichmentService.ProjectEnrichmentService,
    settings: yield* ServerSettings.ServerSettingsService,
  };
});
type Services = Effect.Success<typeof services>;

const projectsOf = (s: Services, repoKey: string) =>
  s.projects.listShells().pipe(
    Effect.map((shells) => shells.filter((shell) => repoKeyOf(shell) === repoKey)),
    Effect.orElseSucceed((): ReadonlyArray<OrchestrationProjectShell> => []),
  );

/** Registers the clone's project, then refreshes what an empty folder cached about it. */
const cloneHooks = (s: Services): ProjectCloneTracker.ProjectCloneHooks => ({
  createProject: (project) =>
    s.projects
      .create({
        commandId: mirrorCommand("create", project.projectId),
        projectId: project.projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        createWorkspaceRootIfMissing: true,
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: "Failed to create the mirrored project.",
              cause,
            }),
        ),
      ),
  onCloned: (project) =>
    s.resolver.resolve(project.workspaceRoot, { refresh: true }).pipe(
      Effect.andThen(
        s.projects.update({
          commandId: mirrorCommand("cloned", project.projectId),
          projectId: project.projectId,
        }),
      ),
      Effect.andThen(s.enrichment.invalidate([project.workspaceRoot])),
      Effect.andThen(s.enrichment.request(project.workspaceRoot)),
      Effect.ignoreCause({ log: true }),
    ),
});

// ── Receiving machine ───────────────────────────────────────────────────

export const makePeerHandlers = Effect.gen(function* () {
  const s = yield* services;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const accept = Effect.fn("projectMirror.accept")(function* (body: unknown) {
    const label = (yield* environment.getDescriptor).label;
    if (fleetConfig()?.mirrorProjects === false) {
      return yield* fail("invalid_request", `Project mirroring is off on ${label}.`);
    }
    const input = yield* decodePeerMirror(body).pipe(
      Effect.mapError(() => fail("invalid_request", "Invalid project mirror request.")),
    );
    const existing = yield* projectsOf(s, input.repoKey);
    if (input.action === "delete") {
      for (const project of existing) {
        yield* s.projects
          .delete({
            commandId: mirrorCommand("delete", project.id),
            projectId: project.id,
            force: true,
          })
          .pipe(Effect.mapError((error) => fail("orchestration_error", error.message)));
        yield* s.clones.discard(project.id);
      }
      return { deleted: existing.length };
    }
    if (existing.length > 0) return { status: "exists" as const };

    const settings = yield* s.settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const base = settings?.addProjectBaseDirectory || "~";
    const projectId = ProjectId.make(NodeCrypto.randomUUID());
    for (const destinationPath of cloneFolderCandidates(base, input.remoteUrl)) {
      if (!isOccupied(destinationPath)) {
        const started = yield* s.clones
          .start(
            {
              projectId,
              title: input.title,
              createdAt: new Date().toISOString(),
              remoteUrl: input.remoteUrl,
              destinationPath,
            },
            cloneHooks(s),
          )
          .pipe(
            Effect.mapError((error) =>
              fail("orchestration_error", `Could not clone ${input.remoteUrl}: ${error.message}`),
            ),
          );
        yield* Effect.logInfo("fleet project mirror: cloning", {
          from: input.machine,
          remoteUrl: input.remoteUrl,
          cwd: started.cwd,
        });
        return { status: "cloning" as const, workspaceRoot: started.cwd };
      }
      // A folder left by an earlier delete is the same repository: register it again.
      const there = yield* s.resolver.resolve(expandHome(destinationPath), { refresh: true });
      if (there !== null && repositoryGroupingKeyOf(there) === input.repoKey) {
        yield* s.projects
          .create({
            commandId: mirrorCommand("create", projectId),
            projectId,
            title: input.title,
            workspaceRoot: there.rootPath ?? expandHome(destinationPath),
          })
          .pipe(Effect.mapError((error) => fail("orchestration_error", error.message)));
        return { status: "registered" as const };
      }
    }
    return yield* fail(
      "invalid_request",
      `Every folder for ${cloneFolderName(input.remoteUrl)} under ${base} is taken.`,
    );
  });

  return new Map([["peer/project-mirror", accept]]);
});

// ── Creating machine ────────────────────────────────────────────────────

export const runMirror = Effect.gen(function* () {
  const config = fleetConfig();
  if (config === null) return;
  const option = yield* Effect.serviceOption(ProjectCloneTracker.ProjectCloneTracker);
  if (Option.isNone(option)) return;
  const s = yield* services;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const git = yield* GitWorkflow.GitWorkflowService;
  const managed = yield* ManagedProjectFolders.ManagedProjectFolders;
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const lock = yield* Semaphore.make(1);
  const { userdataDir } = config;
  const update = (change: (state: MirrorState) => MirrorState) =>
    Effect.sync(() => writeState(userdataDir, change(readState(userdataDir))));

  const peers = Effect.gen(function* () {
    const self = (yield* environment.getDescriptor).environmentId;
    const view = yield* Effect.promise(() => loadView(config, localSnapshot()));
    return view.entries
      .map(({ snapshot }) => snapshot)
      .filter((snapshot) => snapshot.environmentId !== self);
  });

  /** The repository of a project created here, publishing it first when it has none. */
  const sourceRepository = Effect.fn("projectMirror.sourceRepository")(function* (
    projectId: ProjectId,
  ) {
    const project = Option.getOrUndefined(yield* s.projects.getById(projectId));
    if (project === undefined) return "drop" as const;
    const clone = yield* s.clones.get(projectId);
    if (clone !== null && clone.phase !== "done") return "wait" as const;
    if (yield* managed.isScratchProject(projectId)) return "drop" as const;
    const root = project.workspaceRoot;
    const identity = yield* s.resolver.resolve(root, { refresh: true });
    if (identity !== null) return { project, identity };
    if ((yield* git.repositoryRoot(root).pipe(Effect.orElseSucceed(() => null))) === null) {
      yield* Effect.logInfo("fleet project mirror: not a git repository, not mirrored", { root });
      return "drop" as const;
    }
    const published = yield* repositories
      .publishRepository({
        cwd: root,
        provider: SourceControlProviderKind.make("github"),
        repository: NodePath.basename(root),
        visibility: "private",
      })
      .pipe(Effect.result);
    if (published._tag === "Failure") {
      yield* Effect.logWarning("fleet project mirror: publishing to GitHub failed", {
        root,
        error: published.failure.message,
      });
      return "drop" as const;
    }
    yield* Effect.logInfo("fleet project mirror: published as a private GitHub repository", {
      root,
      remoteUrl: published.success.remoteUrl,
    });
    const refreshed = yield* s.resolver.resolve(root, { refresh: true });
    yield* s.enrichment.invalidate([root]);
    return refreshed === null ? ("drop" as const) : { project, identity: refreshed };
  });

  const prepareSources = Effect.gen(function* () {
    const { sources } = readState(userdataDir);
    for (const [id, entry] of Object.entries(sources)) {
      const found = yield* sourceRepository(ProjectId.make(id)).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("fleet project mirror: source check failed", { id, cause }).pipe(
            Effect.as("wait" as const),
          ),
        ),
      );
      if (found === "wait" && Date.now() - entry.createdAt < SOURCE_TTL_MS) continue;
      const targets = found === "wait" || found === "drop" ? [] : yield* peers;
      yield* update((state) => {
        const { [id]: _done, ...rest } = state.sources;
        const next = { ...state, sources: rest };
        if (typeof found !== "object") return next;
        return enqueue(
          next,
          targets.map((peer) => peer.environmentId),
          {
            action: "create",
            repoKey: repositoryGroupingKeyOf(found.identity),
            remoteUrl: remoteUrlOf(found.identity),
            title: found.project.title,
            createdAt: Date.now(),
          },
        );
      });
    }
  });

  const deliver = Effect.gen(function* () {
    const { deliveries } = readState(userdataDir);
    if (Object.keys(deliveries).length === 0) return;
    const machines = yield* peers;
    const label = (yield* environment.getDescriptor).label;
    const done: Array<string> = [];
    for (const [key, delivery] of Object.entries(deliveries)) {
      const machine = machines.find((peer) => peer.environmentId === delivery.environmentId);
      const expired = Date.now() - delivery.createdAt > DELIVERY_TTL_MS;
      if (machine === undefined) {
        if (expired) done.push(key);
        continue;
      }
      const { environmentId: _target, createdAt: _at, ...request } = delivery;
      const reply = yield* Effect.tryPromise({
        try: () =>
          fleetRequest(config, `${machine.baseUrl}/fork/fleet/peer/project-mirror`, {
            ...request,
            machine: label,
          }) as Promise<PeerReply>,
        catch: (cause) => new FleetOperationError({ cause }),
      }).pipe(Effect.option);
      if (Option.isNone(reply)) {
        if (expired) done.push(key);
        continue;
      }
      const answer = reply.value;
      yield* answer.ok
        ? Effect.logInfo("fleet project mirror: delivered", {
            machine: machine.label,
            action: delivery.action,
            repoKey: delivery.repoKey,
            result: answer.result,
          })
        : Effect.logWarning("fleet project mirror: refused", {
            machine: machine.label,
            action: delivery.action,
            repoKey: delivery.repoKey,
            failure: answer.failure,
          });
      // A refusal (mirroring off, a folder in the way) will not change on retry.
      done.push(key);
    }
    if (done.length > 0) {
      yield* update((state) => {
        const deliveries = { ...state.deliveries };
        for (const key of done) delete deliveries[key];
        return { ...state, deliveries };
      });
    }
  });

  const start = readState(userdataDir).cursor ?? (yield* events.latestApplicationSequence);
  let seen = start;

  const sweep = lock.withPermits(1)(
    Effect.gen(function* () {
      if (readState(userdataDir).cursor !== seen) {
        yield* update((state) => ({ ...state, cursor: seen }));
      }
      if (fleetConfig()?.mirrorProjects === false) return;
      yield* prepareSources;
      yield* deliver;
    }).pipe(
      Effect.catchCause((cause) => Effect.logDebug("fleet project mirror failed", { cause })),
    ),
  );

  const onEvent = Effect.fn("projectMirror.onEvent")(function* (event: ProjectLifecycleEvent) {
    if (!isMirrorCommand(event.commandId) && fleetConfig()?.mirrorProjects !== false) {
      if (event.type === "project.created") {
        const id = event.payload.projectId;
        yield* update((state) => ({
          ...state,
          sources: { ...state.sources, [id]: { createdAt: Date.now() } },
        }));
      } else {
        yield* queueDelete(event.payload.projectId);
      }
    }
    seen = event.sequence;
  });

  /** A deleted project goes out only when no other project here still checks out its repository. */
  const queueDelete = Effect.fn("projectMirror.queueDelete")(function* (projectId: ProjectId) {
    const project = Option.getOrUndefined(
      yield* s.projects.getById(projectId, { includeDeleted: true }),
    );
    yield* update((state) => {
      const { [projectId]: _pending, ...sources } = state.sources;
      return { ...state, sources };
    });
    if (project === undefined) return;
    const identity =
      project.repositoryIdentity ?? (yield* s.resolver.resolve(project.workspaceRoot));
    if (identity === null) return;
    const repoKey = repositoryGroupingKeyOf(identity);
    if ((yield* projectsOf(s, repoKey)).length > 0) return;
    const targets = yield* peers;
    yield* update((state) =>
      enqueue(
        state,
        targets.map((peer) => peer.environmentId),
        { action: "delete", repoKey, createdAt: Date.now() },
      ),
    );
  });

  yield* update((state) => ({ ...state, cursor: start }));
  yield* events
    .streamProjectedApplicationEvents({
      afterSequence: start,
      project: (event) => event,
      filter: isProjectLifecycleEvent,
    })
    .pipe(
      Stream.filter(isProjectLifecycleEvent),
      Stream.runForEach((event) =>
        onEvent(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("fleet project mirror: event failed", { cause }),
          ),
          Effect.andThen(sweep),
        ),
      ),
      Effect.catchCause((cause) => Effect.logWarning("fleet project mirror stopped", { cause })),
      Effect.forkScoped,
    );
  yield* sweep.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(30))));
});

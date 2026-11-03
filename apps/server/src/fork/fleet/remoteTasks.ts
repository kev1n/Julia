// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: delegate_task on another machine. The child is a subagent thread there whose lineage
 * names its parent (`remoteParentThreadId`), with task id `fleet:<environmentId>:<threadId>`;
 * node records cannot span databases, so the parent's run has none. Undelivered results persist in
 * `fork-remote-tasks.json`, so a restart or unreachable parent only delays delivery.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CommandId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestratorMcpFailure,
  OrchestratorMcpTarget,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  repositoryGroupingKeyOf,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../../mcp/delegatedTaskModes.ts";
import { readCaller } from "../../mcp/threadAccess.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { HEARTBEAT_MS, FleetHttpError, fleetRequest, readFleetConfig } from "./config.ts";
import type { FleetLifecycle, FleetSnapshot } from "./model.ts";
import { PeerSource, peerScope } from "./peer.ts";
import { fleetConfig, lifecycleOf, localSnapshot } from "./publisher.ts";
import { loadView } from "./view.ts";

type Result = OrchestratorMcpDelegateTaskResult;

const fail = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const TASK_ID_PREFIX = "fleet:";
const DEFAULT_WAIT_MS = 10 * 60 * 1_000;
const MAX_WAIT_MS = 60 * 60 * 1_000;
/** One peer/task wait, under fleetRequest's timeout. */
const WAIT_SLICE_MS = HEARTBEAT_MS - 2_000;
const MAX_MESSAGE_CHARS = 100_000;
/** A result its parent machine never took is dropped after this long. */
const UNDELIVERED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export const isRemoteTaskId = (taskId: string) => taskId.startsWith(TASK_ID_PREFIX);

const remoteTaskId = (environmentId: string, threadId: string) =>
  NodeId.make(`${TASK_ID_PREFIX}${environmentId}:${threadId}`);

function parseRemoteTaskId(taskId: string) {
  const rest = taskId.slice(TASK_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { environmentId: rest.slice(0, separator), threadId: rest.slice(separator + 1) };
}

const isTerminal = (status: Result["status"]) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted";

// ── Wire ────────────────────────────────────────────────────────────────

const PeerDelegate = Schema.Struct({
  source: PeerSource,
  /** Idempotency: the same source thread and key launch one thread. */
  key: Schema.String,
  repoKey: Schema.String,
  baseRef: Schema.NullOr(Schema.String),
  title: Schema.String,
  task: Schema.String,
  target: Schema.optional(OrchestratorMcpTarget),
  parentModelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const PeerTask = Schema.Struct({
  source: PeerSource,
  threadId: ThreadId,
  waitMs: Schema.optional(Schema.Number),
  /** A terminal result read by the parent needs no automatic delivery. */
  acknowledge: Schema.optional(Schema.Boolean),
});
const PeerProviders = Schema.Struct({ source: PeerSource, search: Schema.optional(Schema.String) });
const PeerTaskCancel = Schema.Struct({
  source: PeerSource,
  threadId: ThreadId,
  reason: Schema.optional(Schema.String),
});
const PeerTaskResult = Schema.Struct({
  machine: Schema.String,
  parentThreadId: ThreadId,
  taskId: Schema.String,
  title: Schema.String,
  link: Schema.String,
  status: Schema.String,
  summary: Schema.NullOr(Schema.String),
  key: Schema.String,
});

const PeerThreadLifecycles = Schema.Struct({ threadIds: Schema.Array(ThreadId) });

type PeerReply<A> =
  | { readonly ok: true; readonly result: A }
  | {
      readonly ok: false;
      readonly failure: { code: OrchestratorMcpFailure["code"]; message: string };
    };

const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (body: unknown) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => fail("invalid_request", "Invalid fleet task request.")),
    );

// ── Undelivered results (child machine) ─────────────────────────────────

interface PendingDelivery {
  readonly source: PeerSource;
  readonly createdAt: number;
}

const pendingPath = (userdataDir: string) => NodePath.join(userdataDir, "fork-remote-tasks.json");

function readPending(userdataDir: string): Record<string, PendingDelivery> {
  try {
    return JSON.parse(NodeFS.readFileSync(pendingPath(userdataDir), "utf8")) as Record<
      string,
      PendingDelivery
    >;
  } catch {
    return {};
  }
}

function writePending(userdataDir: string, pending: Record<string, PendingDelivery>) {
  const path = pendingPath(userdataDir);
  NodeFS.writeFileSync(`${path}.tmp`, JSON.stringify(pending), { mode: 0o600 });
  NodeFS.renameSync(`${path}.tmp`, path);
}

function updatePending(
  userdataDir: string,
  update: (pending: Record<string, PendingDelivery>) => void,
) {
  const pending = readPending(userdataDir);
  update(pending);
  writePending(userdataDir, pending);
}

// ── Parent machine: the MCP tools ───────────────────────────────────────

/** The fleet machine `machine` names, or null when it is this one. */
export const resolveMachine = Effect.fn("remoteTasks.resolveMachine")(function* (machine: string) {
  const config = fleetConfig();
  if (config === null) {
    return yield* fail("invalid_request", "The fleet is not configured on this machine.");
  }
  const view = yield* Effect.promise(() => loadView(config, localSnapshot()));
  const wanted = machine.trim().toLowerCase();
  const entry = view.entries.find(
    ({ snapshot }) =>
      snapshot.environmentId.toLowerCase() === wanted || snapshot.label.toLowerCase() === wanted,
  );
  if (entry === undefined) {
    const known = view.entries.map(({ snapshot }) => snapshot.label).join(", ") || "none";
    return yield* fail(
      "invalid_request",
      `No fleet machine is called ${machine} (hub ${view.hub}; known: ${known}).`,
    );
  }
  return entry.snapshot.environmentId === localSnapshot()?.environmentId ? null : entry.snapshot;
});

const callingThread = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  if (scope.thread === undefined || caller === undefined) {
    return yield* fail(
      "thread_credential_required",
      "Reaching another machine needs an agent running inside a T3 thread.",
    );
  }
  const source = {
    environmentId: scope.environmentId,
    label: localSnapshot()?.label ?? scope.environmentId,
    threadId: caller.id,
    title: caller.title,
    runtimeMode: caller.runtimeMode,
  } satisfies PeerSource;
  return { caller, source };
});

/** POST to a peer and unwrap its reply. */
const ask = <A>(target: Pick<FleetSnapshot, "baseUrl" | "label">, path: string, body: unknown) =>
  Effect.tryPromise(() =>
    fleetRequest(fleetConfig()!, `${target.baseUrl}/fork/fleet/${path}`, body),
  ).pipe(
    Effect.mapError((error) => {
      const cause = error.cause;
      const ambiguous = cause instanceof FleetHttpError && cause.ambiguous;
      return fail(
        "orchestration_error",
        `${target.label} did not answer${ambiguous ? " (the request may have been applied; retrying with the same clientRequestId is safe)" : ""}: ${String(cause ?? error)}`,
      );
    }),
    Effect.flatMap((reply) => {
      const typed = reply as PeerReply<A>;
      return typed.ok
        ? Effect.succeed(typed.result)
        : Effect.fail(fail(typed.failure.code, `${target.label}: ${typed.failure.message}`));
    }),
  );

/** Wait on the child machine in slices until the task ends or the budget runs out. */
const waitRemote = Effect.fn("remoteTasks.waitRemote")(function* (
  target: FleetSnapshot,
  source: PeerSource,
  threadId: ThreadId,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    const started = Date.now();
    const result = yield* ask<Result>(target, "peer/task", {
      source,
      threadId,
      waitMs: Math.max(0, Math.min(WAIT_SLICE_MS, remaining)),
      acknowledge: true,
    });
    if (isTerminal(result.status)) return result;
    if (Date.now() >= deadline) return { ...result, waitTimedOut: true };
    // A run not created yet returns at once; do not spin on it.
    if (Date.now() - started < 1_000) yield* Effect.sleep(Duration.seconds(1));
  }
});

export const delegate = Effect.fn("remoteTasks.delegate")(function* (
  target: FleetSnapshot,
  input: OrchestratorMcpDelegateTaskInput,
) {
  const { caller, source } = yield* callingThread;
  const runtimeMode = yield* OrchestratorMcpService.resolveDelegatedRuntimeMode(
    caller.runtimeMode,
    input.runtimeMode,
  );
  const interactionMode = yield* resolveInteractionMode(
    caller.interactionMode,
    input.interactionMode,
  );
  const snapshot = localSnapshot();
  const own = snapshot?.threads.find((thread) => thread.threadId === caller.id);
  if (own?.repoKey == null) {
    return yield* fail(
      "invalid_request",
      "This thread's repository is not known to the fleet yet (it publishes every few seconds), or it is not a git repository.",
    );
  }
  const base = snapshot?.checkouts.find((checkout) => checkout.key === own.checkoutKey)?.base;
  const task =
    input.role === undefined || input.role === "general"
      ? input.task
      : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
  const accepted = yield* ask<Result>(target, "peer/delegate", {
    source,
    key: input.clientRequestId ?? NodeCrypto.randomUUID(),
    repoKey: own.repoKey,
    baseRef: base?.ref.replace(/^origin\//, "") ?? null,
    title: input.title ?? (task.length > 80 ? `${task.slice(0, 77)}...` : task),
    task,
    ...(input.target === undefined ? {} : { target: input.target }),
    parentModelSelection: caller.modelSelection,
    runtimeMode,
    interactionMode,
  });
  if (input.mode !== "wait") return accepted;
  const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_MS));
  if (accepted.childThreadId === null) return accepted;
  return yield* waitRemote(target, source, accepted.childThreadId, timeoutMs);
});

/** Another machine's provider instances and models, as orchestrator_capabilities lists them. */
export const providers = Effect.fn("remoteTasks.providers")(function* (
  target: FleetSnapshot,
  search: string | undefined,
) {
  const { source } = yield* callingThread;
  return yield* ask<OrchestratorMcpCapabilitiesResult["providers"]>(target, "peer/providers", {
    source,
    ...(search === undefined ? {} : { search }),
  });
});

const ownerOf = Effect.fn("remoteTasks.ownerOf")(function* (taskId: string) {
  const parsed = parseRemoteTaskId(taskId);
  if (parsed === null) return yield* fail("task_not_found", `Task ${taskId} is malformed.`);
  const target = yield* resolveMachine(parsed.environmentId);
  if (target === null) {
    return yield* fail("task_not_found", `Task ${taskId} names this machine.`);
  }
  return { target, threadId: ThreadId.make(parsed.threadId) };
});

export const status = Effect.fn("remoteTasks.status")(function* (taskId: string) {
  const { source } = yield* callingThread;
  const { target, threadId } = yield* ownerOf(taskId);
  return yield* ask<Result>(target, "peer/task", { source, threadId, acknowledge: true });
});

export const cancel = Effect.fn("remoteTasks.cancel")(function* (
  input: OrchestratorMcpTaskCancelInput,
) {
  const { source } = yield* callingThread;
  const { target, threadId } = yield* ownerOf(input.taskId);
  return yield* ask<OrchestratorMcpTaskCancelResult>(target, "peer/task-cancel", {
    source,
    threadId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
});

// ── Both machines: the peer routes ──────────────────────────────────────

export type PeerHandlers = ReadonlyMap<
  string,
  (body: unknown) => Effect.Effect<unknown, OrchestratorMcpFailure>
>;

/** Built once with the route layer, which captures the services. */
export const makePeerHandlers = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const service = yield* OrchestratorMcpService.OrchestratorMcpService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // Optional, so test servers built without these services run without remote tasks.
  const [launchesOption, projectsOption, resolverOption] = yield* Effect.all([
    Effect.serviceOption(ThreadLaunch.ThreadLaunchService),
    Effect.serviceOption(ProjectStore.ProjectStoreV2),
    Effect.serviceOption(RepositoryIdentityResolver.RepositoryIdentityResolver),
  ]);
  if (
    Option.isNone(launchesOption) ||
    Option.isNone(projectsOption) ||
    Option.isNone(resolverOption)
  ) {
    const none: PeerHandlers = new Map();
    return none;
  }
  const launches = launchesOption.value;
  const projects = projectsOption.value;
  const resolver = resolverOption.value;
  const unavailable = () => fail("orchestration_error", "Thread state is unavailable.");

  const project = Effect.fn("remoteTasks.project")(function* (repoKey: string) {
    const shells = yield* projects.listShells().pipe(Effect.mapError(unavailable));
    for (const shell of shells) {
      const identity = shell.repositoryIdentity ?? (yield* resolver.resolve(shell.workspaceRoot));
      if (identity !== null && repositoryGroupingKeyOf(identity) === repoKey) return shell;
    }
    return yield* fail("invalid_request", `No project here is a checkout of ${repoKey}.`);
  });

  const modelSelection = Effect.fn("remoteTasks.modelSelection")(function* (
    scope: ReturnType<typeof peerScope>,
    target: OrchestratorMcpTarget | undefined,
    parent: ModelSelection,
  ) {
    // Capabilities list a short model list; searching for the requested model finds it.
    const { providers } = yield* service.capabilities(
      scope,
      target?.model === undefined ? {} : { search: target.model },
    );
    const instanceId =
      target?.providerInstanceId ??
      (target?.driverKind === undefined
        ? parent.instanceId
        : providers.find((provider) => provider.driverKind === target.driverKind)
            ?.providerInstanceId);
    const provider = providers.find((candidate) => candidate.providerInstanceId === instanceId);
    if (provider === undefined) {
      const known = providers.map((candidate) => candidate.providerInstanceId).join(", ");
      return yield* fail(
        "provider_unavailable",
        `No provider instance ${instanceId ?? target?.driverKind} here; available: ${known}.`,
      );
    }
    const sameAsParent = provider.providerInstanceId === parent.instanceId;
    const model =
      target?.model ?? (sameAsParent ? parent.model : provider.models[0]?.id) ?? undefined;
    if (
      model === undefined ||
      (provider.models.length > 0 &&
        !provider.models.some((candidate) => candidate.id === model) &&
        (provider.omittedModels ?? 0) === 0)
    ) {
      return yield* fail(
        "model_unavailable",
        `Model ${model ?? "(none)"} is not offered by ${provider.providerInstanceId} here.`,
      );
    }
    const options =
      target?.options ?? (sameAsParent && model === parent.model ? parent.options : undefined);
    return {
      instanceId: provider.providerInstanceId,
      model,
      ...(options === undefined ? {} : { options }),
    } as ModelSelection;
  });

  /** The task as the parent sees it: the child thread's first run. */
  const taskView = Effect.fn("remoteTasks.taskView")(function* (
    threadId: ThreadId,
    waitTimedOut = false,
  ) {
    const descriptor = yield* environment.getDescriptor;
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* fail("task_not_found", `Thread ${threadId} is not on this machine.`);
    }
    const { runs, runtimeRequests } = yield* threads
      .getThreadRecords(threadId, ["runs", "runtimeRequests"])
      .pipe(Effect.mapError(unavailable));
    const ordered = runs.toSorted((left, right) => left.ordinal - right.ordinal);
    const run = ordered[0];
    const latest = ordered.findLast((candidate) =>
      ThreadManagementService.isTerminalRunStatus(candidate.status),
    );
    const status = OrchestratorMcpService.taskStatusForRun(run);
    const resultRuns = [run, latest].filter(
      (candidate): candidate is OrchestrationV2Run =>
        candidate !== undefined && ThreadManagementService.isTerminalRunStatus(candidate.status),
    );
    const records =
      resultRuns.length === 0
        ? { messages: [], turnItems: [] }
        : yield* threads
            .getThreadRecords(threadId, ["messages", "turnItems"], {
              messageRoles: ["assistant"],
              messageRunIds: resultRuns.map((candidate) => candidate.id),
              turnItemRunIds: resultRuns.map((candidate) => candidate.id),
              turnItemTypes: ["assistant_message", "error"],
            })
            .pipe(Effect.mapError(unavailable));
    const summaryOf = (candidate: OrchestrationV2Run | undefined) =>
      candidate !== undefined && ThreadManagementService.isTerminalRunStatus(candidate.status)
        ? subagentResultForRun(records, candidate).text
        : null;
    const latestStatus =
      latest === undefined ? null : OrchestratorMcpService.taskStatusForRun(latest);
    const taskId = remoteTaskId(descriptor.environmentId, threadId);
    return {
      taskId,
      childThreadId: threadId,
      childRunId: run?.id ?? null,
      childNodeId: taskId,
      status,
      workState: isTerminal(status) ? "result_available" : "working",
      hasPendingChildRuns: ordered
        .slice(1)
        .some((candidate) => !ThreadManagementService.isTerminalRunStatus(candidate.status)),
      latestTerminalRunId: latest?.id ?? null,
      latestTerminalStatus:
        latestStatus !== null && isTerminal(latestStatus)
          ? (latestStatus as NonNullable<Result["latestTerminalStatus"]>)
          : null,
      latestTerminalSummary: summaryOf(latest),
      latestTerminalResultContextTransferId: null,
      providerInstanceId: shell.modelSelection.instanceId,
      model: shell.modelSelection.model,
      summary: summaryOf(run),
      resultContextTransferId: null,
      // Answered on that machine; the parent cannot reach its requests from here.
      hasPendingQuestion:
        !isTerminal(status) &&
        runtimeRequests.some(
          (request) =>
            request.kind === "user_input" &&
            request.status === "pending" &&
            request.responseCapability.type === "live",
        ),
      // Approvals are held on that machine too; nothing here can answer them.
      pendingApproval: null,
      waitTimedOut,
      machine: descriptor.label,
      link: formatThreadLink({ environmentId: descriptor.environmentId, threadId }, shell.title),
    } satisfies Result;
  });

  const userdataDir = () => {
    const config = fleetConfig();
    return config === null ? null : config.userdataDir;
  };

  const acceptDelegation = Effect.fn("remoteTasks.acceptDelegation")(function* (body: unknown) {
    const input = yield* decode(PeerDelegate)(body);
    const descriptor = yield* environment.getDescriptor;
    const scope = peerScope(descriptor.environmentId, input.source);
    // The parent's own modes are the ceiling, as for any peer request.
    yield* resolveRuntimeMode(input.source.runtimeMode, input.runtimeMode);
    const target = yield* project(input.repoKey);
    const selection = yield* modelSelection(scope, input.target, input.parentModelSelection);
    const commandId = CommandId.make(
      `fleet-delegate:${NodeCrypto.createHash("sha256")
        .update(`${input.source.environmentId}\n${input.source.threadId}\n${input.key}`)
        .digest("hex")
        .slice(0, 32)}`,
    );
    const launched = yield* launches
      .launch({
        commandId,
        projectId: target.id,
        title: input.title,
        modelSelection: selection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        workspaceStrategy: {
          type: "worktree",
          baseRef: input.baseRef ?? "HEAD",
          startFromOrigin: input.baseRef !== null,
        },
        remoteParentThreadId: ThreadId.make(input.source.threadId),
        initialMessage: {
          messageId: MessageId.make(commandId),
          text: `[Delegated task from ${input.source.label}, thread "${input.source.title}". Your final message is sent back to that thread as the task result. You run in a fresh worktree of ${input.baseRef ?? "this checkout's HEAD"}: the parent's uncommitted or unpushed work is not here.]\n\n${input.task}`,
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(
        Effect.mapError((error) =>
          fail("orchestration_error", `Could not start the task: ${error.message}`),
        ),
      );
    const threadId = launched.projection.thread.id;
    const dir = userdataDir();
    if (dir !== null) {
      updatePending(dir, (pending) => {
        pending[threadId] ??= { source: input.source, createdAt: Date.now() };
      });
    }
    return yield* taskView(threadId);
  });

  const readTask = Effect.fn("remoteTasks.readTask")(function* (body: unknown) {
    const input = yield* decode(PeerTask)(body);
    let timedOut = false;
    if (input.waitMs !== undefined && input.waitMs > 0) {
      const descriptor = yield* environment.getDescriptor;
      const waited = yield* service.waitForThread(
        peerScope(descriptor.environmentId, input.source),
        { threadId: input.threadId, timeoutMs: input.waitMs },
      );
      timedOut = waited.timedOut;
    }
    const result = yield* taskView(input.threadId, timedOut);
    const dir = userdataDir();
    if (input.acknowledge === true && isTerminal(result.status) && dir !== null) {
      updatePending(dir, (pending) => {
        delete pending[input.threadId];
      });
    }
    return result;
  });

  const cancelTask = Effect.fn("remoteTasks.cancelTask")(function* (body: unknown) {
    const input = yield* decode(PeerTaskCancel)(body);
    const descriptor = yield* environment.getDescriptor;
    const interrupted = yield* service.interruptThread(
      peerScope(descriptor.environmentId, input.source),
      {
        threadId: input.threadId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    );
    const dir = userdataDir();
    if (dir !== null) {
      updatePending(dir, (pending) => {
        delete pending[input.threadId];
      });
    }
    const taskId = remoteTaskId(descriptor.environmentId, input.threadId);
    const status = (yield* taskView(input.threadId)).status;
    return {
      taskId,
      status:
        interrupted.status === "interrupt_requested" || !isTerminal(status)
          ? "cancel_requested"
          : (status as Exclude<OrchestratorMcpTaskCancelResult["status"], "cancel_requested">),
    } satisfies OrchestratorMcpTaskCancelResult;
  });

  const listProviders = Effect.fn("remoteTasks.listProviders")(function* (body: unknown) {
    const input = yield* decode(PeerProviders)(body);
    const descriptor = yield* environment.getDescriptor;
    return (yield* service.capabilities(
      peerScope(descriptor.environmentId, input.source),
      input.search === undefined ? {} : { search: input.search },
    )).providers;
  });

  /** Parent machine: the lifecycle of each named thread here, subagents included. */
  const threadLifecycles = Effect.fn("remoteTasks.threadLifecycles")(function* (body: unknown) {
    const input = yield* decode(PeerThreadLifecycles)(body);
    const answer: Record<string, FleetLifecycle> = {};
    for (const threadId of input.threadIds) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      if (shell !== null && shell.deletedAt === null) answer[threadId] = lifecycleOf(shell);
    }
    return answer;
  });

  /** Parent machine: a child elsewhere finished; wake the parent thread with its result. */
  const acceptResult = Effect.fn("remoteTasks.acceptResult")(function* (body: unknown) {
    const input = yield* decode(PeerTaskResult)(body);
    const descriptor = yield* environment.getDescriptor;
    const parent = yield* threads
      .getThreadShell(input.parentThreadId)
      .pipe(Effect.mapError(unavailable));
    if (parent === null || parent.deletedAt !== null) {
      return yield* fail("thread_not_found", `Thread ${input.parentThreadId} is gone.`);
    }
    const summary = input.summary ?? "(no final message)";
    const message = `[Remote task on ${input.machine} ${input.status}: ${input.link}, taskId ${input.taskId}]\n\n${
      summary.length > MAX_MESSAGE_CHARS
        ? `${summary.slice(0, MAX_MESSAGE_CHARS)}\n\n[truncated; read the rest with t3_fleet_thread_read]`
        : summary
    }`;
    // The parent's own result: delivered within the parent's own modes.
    return yield* service.sendToThread(
      peerScope(descriptor.environmentId, {
        environmentId: descriptor.environmentId,
        label: input.machine,
        threadId: input.taskId,
        title: input.title,
        runtimeMode: parent.runtimeMode,
      }),
      { threadId: input.parentThreadId, message, mode: "auto", clientRequestId: input.key },
    );
  });

  return new Map<string, (body: unknown) => Effect.Effect<unknown, OrchestratorMcpFailure>>([
    ["peer/delegate", acceptDelegation],
    ["peer/providers", listProviders],
    ["peer/task", readTask],
    ["peer/task-cancel", cancelTask],
    ["peer/task-result", acceptResult],
    ["peer/thread-lifecycles", threadLifecycles],
  ]) satisfies PeerHandlers;
});

// ── Child machine: delivering results and following the parent ─────────

type ParentLifecycles = Readonly<Record<string, FleetLifecycle>>;

/**
 * Idle subagents here whose parent, on another machine, is settled or archived
 * there (a running child is settled on a later sweep, once its turn ends).
 * Each machine answers for its own threads, subagents included; a machine that
 * does not answer leaves its children as they are until a later sweep.
 */
export const remoteChildrenToSettle = Effect.fn("remoteTasks.remoteChildrenToSettle")(function* (
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  machines: ReadonlyArray<FleetSnapshot>,
  ask: (
    machine: FleetSnapshot,
    parentIds: ReadonlyArray<string>,
  ) => Effect.Effect<ParentLifecycles | null>,
) {
  const local = new Set<string>(shells.map((shell) => shell.id));
  const children = shells.filter(
    (shell) =>
      shell.lineage.relationshipToParent === "subagent" &&
      shell.lineage.parentThreadId !== null &&
      !local.has(shell.lineage.parentThreadId) &&
      shell.deletedAt === null &&
      lifecycleOf(shell) === "idle",
  );
  if (children.length === 0) return [];
  const parentIds = [...new Set(children.map((shell) => shell.lineage.parentThreadId!))];
  const answers = yield* Effect.forEach(machines, (machine) => ask(machine, parentIds), {
    concurrency: "unbounded",
  });
  const ended = new Set(
    answers.flatMap((answer) =>
      Object.entries(answer ?? {}).flatMap(([threadId, lifecycle]) =>
        lifecycle === "settled" || lifecycle === "archived" ? [threadId] : [],
      ),
    ),
  );
  return children
    .filter((shell) => ended.has(shell.lineage.parentThreadId!))
    .map((shell) => shell.id);
});

/**
 * Sends each finished remote task's result to its parent thread. Runs on
 * every terminal run of a pending thread and every 30 s (retries, restarts).
 */
export const runDelivery = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const config = readFleetConfig(NodePath.dirname(serverConfig.environmentIdPath));
  if (config === null) return;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const lock = yield* Semaphore.make(1);

  const deliverOne = Effect.fn("remoteTasks.deliverOne")(
    function* (threadId: string, entry: PendingDelivery) {
      const descriptor = yield* environment.getDescriptor;
      const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
      if (shell === null || shell.deletedAt !== null) return "drop" as const;
      const { runs } = yield* threads.getThreadRecords(ThreadId.make(threadId), ["runs"]);
      const run = runs.toSorted((left, right) => left.ordinal - right.ordinal)[0];
      if (run === undefined || !ThreadManagementService.isTerminalRunStatus(run.status)) {
        return Date.now() - entry.createdAt > UNDELIVERED_TTL_MS ? ("drop" as const) : null;
      }
      const records = yield* threads.getThreadRecords(
        ThreadId.make(threadId),
        ["messages", "turnItems"],
        {
          messageRoles: ["assistant"],
          messageRunIds: [run.id],
          turnItemRunIds: [run.id],
          turnItemTypes: ["assistant_message", "error"],
        },
      );
      const view = yield* Effect.promise(() => loadView(config, localSnapshot()));
      const parentMachine = view.entries.find(
        ({ snapshot }) => snapshot.environmentId === entry.source.environmentId,
      )?.snapshot;
      if (parentMachine === undefined) return null;
      const reply = (yield* Effect.tryPromise(() =>
        fleetRequest(config, `${parentMachine.baseUrl}/fork/fleet/peer/task-result`, {
          machine: descriptor.label,
          parentThreadId: entry.source.threadId,
          taskId: remoteTaskId(descriptor.environmentId, threadId),
          title: shell.title,
          link: formatThreadLink(
            { environmentId: descriptor.environmentId, threadId: ThreadId.make(threadId) },
            shell.title,
          ),
          status: OrchestratorMcpService.taskStatusForRun(run),
          summary: subagentResultForRun(records, run).text,
          key: `fleet-task-result:${descriptor.environmentId}:${threadId}:${run.id}`,
        }),
      )) as PeerReply<unknown>;
      // A refusal (parent gone, modes) will not change on retry.
      return reply.ok || reply.failure.code !== "orchestration_error" ? ("drop" as const) : null;
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("fleet remote task delivery failed", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
  );

  /** Settle each remote child whose parent was settled or archived on its machine. */
  const followParents = Effect.gen(function* () {
    const { threads: shells } = yield* orchestrator.getShellSnapshot({ location: "active" });
    const descriptor = yield* environment.getDescriptor;
    // The index only supplies addresses; each parent's state comes from its own machine.
    const view = yield* Effect.promise(() => loadView(config, localSnapshot()));
    const machines = view.entries
      .map(({ snapshot }) => snapshot)
      .filter((snapshot) => snapshot.environmentId !== descriptor.environmentId);
    const ask = (machine: FleetSnapshot, threadIds: ReadonlyArray<string>) =>
      Effect.tryPromise(() =>
        fleetRequest(config, `${machine.baseUrl}/fork/fleet/peer/thread-lifecycles`, {
          threadIds,
        }),
      ).pipe(
        Effect.flatMap((reply) => {
          const typed = reply as PeerReply<ParentLifecycles>;
          return typed.ok ? Effect.succeed(typed.result) : Effect.fail(typed.failure);
        }),
        // No answer is no evidence: its children stay as they are this sweep.
        Effect.orElseSucceed(() => null),
      );
    for (const threadId of yield* remoteChildrenToSettle(shells, machines, ask)) {
      yield* threads
        .settleThread({
          threadId,
          commandId: CommandId.make(`fleet-parent-settled:${NodeCrypto.randomUUID()}`),
          byOwnAgent: false,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("settling a remote child failed", { threadId, cause }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logDebug("following remote parents failed", { cause })),
  );

  const sweep = lock.withPermits(1)(
    Effect.gen(function* () {
      yield* followParents;
      const pending = readPending(config.userdataDir);
      const done: string[] = [];
      for (const [threadId, entry] of Object.entries(pending)) {
        if ((yield* deliverOne(threadId, entry)) === "drop") done.push(threadId);
      }
      if (done.length > 0) {
        updatePending(config.userdataDir, (current) => {
          for (const threadId of done) delete current[threadId];
        });
      }
    }),
  );

  yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "run.updated" &&
        ThreadManagementService.isTerminalRunStatus(event.payload.status) &&
        Object.hasOwn(readPending(config.userdataDir), event.payload.threadId),
    ),
    Stream.runForEach(() => sweep),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* sweep.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(30))));
});

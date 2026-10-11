import { resolveProjectScripts, settleProjectScript } from "@t3tools/shared/projectScripts";
import type { ThreadId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as PendingSettleScripts from "./PendingSettleScripts.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
const SETTLE_SCRIPT_SLOT_TIMEOUT = "5 minutes";

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

/** Absolute age bounds clock skew in both directions and expires stale pre-adoption data. */
export function threadHasQueuedTurnStart(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
): boolean {
  const messageAtMs = toMillis(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
}

/** Match client effectiveSnoozed so agents and sidebar agree. */
export function isSnoozed(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "status"
    | "pendingRuntimeRequest"
    | "pendingGuestMessageCount"
  >,
  nowMs: number,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  // Same as the client: a waiting guest message wakes the thread, and the snooze stays stored.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  const snoozedAtMs = toMillis(thread.snoozedAt);
  if (
    thread.pendingRuntimeRequest !== null &&
    (thread.pendingRuntimeRequest.kind !== "user_input" ||
      snoozedAtMs === null ||
      DateTime.toEpochMillis(thread.pendingRuntimeRequest.createdAt) > snoozedAtMs)
  ) {
    return false;
  }
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  return !wokeOnError;
}

export class ThreadSettlementServiceV2 extends Context.Service<
  ThreadSettlementServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/ThreadSettlementService/ThreadSettlementServiceV2") {}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const terminals = yield* TerminalManager.TerminalManager;
  const projectScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  // Re-emitted thread.settled events keep settledAt, so run each settle action once.
  const settleActionRunAt = new Map<ThreadId, number>();

  // Settle scripts run one at a time: a script may clean up across the repository, and a burst of
  // settlements (a restart sweep, a bulk settle) would otherwise start one shell per thread at once.
  const settleScriptRuns = yield* FiberSet.make<void>();
  const settleScriptSlot = yield* Semaphore.make(1);
  const pendingSettleScripts = yield* PendingSettleScripts.PendingSettleScripts;

  // Skip settle scripts in shared checkouts where other threads may still work.
  const runSettleScript = Effect.fn("ThreadSettlementServiceV2.runSettleScript")(
    function* (threadId: ThreadId) {
      // Read the thread once the slot is held: it may have re-engaged, moved or gone while queued.
      const queued = yield* projections.getThread(threadId);
      if (queued.deletedAt !== null || queued.settledOverride !== "settled") return;
      const worktreePath = queued.worktreePath;
      if (worktreePath === null) return;
      if (!(yield* fileSystem.exists(worktreePath))) {
        // A settle script that tears something down would otherwise be skipped with no trace.
        const project = Option.getOrUndefined(yield* projectStore.getShell(queued.projectId));
        if (
          project !== undefined &&
          settleProjectScript(resolveProjectScripts(yield* settingsService.getSettings, project))
        ) {
          yield* Effect.logWarning(
            "settle script skipped: the thread's worktree no longer exists",
            { threadId, worktreePath },
          );
        }
        return;
      }
      // Recheck after worktree I/O; only live, settled threads may run scripts.
      const thread = yield* projections.getThread(threadId);
      if (thread.deletedAt !== null || thread.settledOverride !== "settled") return;
      if (thread.worktreePath !== worktreePath) return;
      const settledAtMs = toMillis(thread.settledAt);
      if (settledAtMs === null || settleActionRunAt.get(threadId) === settledAtMs) return;
      // The parent's worktree belongs to the parent; shared-worktree children
      // (subagents, forks, side chats) skip duplicate cleanup there.
      if (thread.lineage.parentThreadId !== null) {
        const parent = yield* projections.getThread(thread.lineage.parentThreadId).pipe(
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
          }),
        );
        if (parent?.worktreePath === worktreePath) return;
      }
      const run = yield* projectScripts.runForThread({
        threadId,
        projectId: thread.projectId,
        worktreePath,
        trigger: "settle",
        observeCompletion: {},
      });
      settleActionRunAt.set(threadId, settledAtMs);
      if (run.status === "started" && run.completion) {
        // Interrupting the completion closes the script's terminal, so only the wait is bounded:
        // a script that never finishes keeps running but stops holding back later settlements.
        const completion = yield* run.completion.pipe(Effect.forkDetach);
        const finished = yield* Fiber.await(completion).pipe(
          Effect.timeoutOption(SETTLE_SCRIPT_SLOT_TIMEOUT),
        );
        if (Option.isNone(finished)) {
          yield* Effect.logWarning("settle script still running; starting the next one", {
            threadId,
            worktreePath,
            terminalId: run.terminalId,
          });
        }
      }
    },
    (effect, threadId) =>
      effect.pipe(
        settleScriptSlot.withPermits(1),
        pendingSettleScripts.track(threadId),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("running a settle script failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const cleanUpSettledThread = Effect.fn("ThreadSettlementServiceV2.cleanUpSettledThread")(
    function* (threadId: ThreadId) {
      const settled = yield* projections.getThread(threadId);
      if (settled.deletedAt !== null || settled.settledOverride !== "settled") return;
      yield* terminals.closeOnSettle({ threadId });
      if (settled.worktreePath === null) return;
      yield* runSettleScript(threadId).pipe(FiberSet.run(settleScriptRuns));
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("cleaning up a settled thread failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const start: ThreadSettlementServiceV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementServiceV2.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "thread.settled" ? cleanUpSettledThread(event.threadId) : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread settlement event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start } satisfies ThreadSettlementServiceV2["Service"];
});

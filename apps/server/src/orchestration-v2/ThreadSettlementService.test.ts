import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  ProjectId,
  EventId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";

const NOW = "2026-06-10T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1_000;
const PROJECT_ID = ProjectId.make("project-1");

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("threadHasQueuedTurnStart", () => {
  it("holds a fresh unadopted user message inside the grace window only", () => {
    const fresh = shell({ latestUserMessageAt: at(-1_000) });
    expect(ThreadSettlementService.threadHasQueuedTurnStart(fresh, NOW_MS)).toBe(true);
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({
          latestUserMessageAt: at(-1_000),
          latestRunId: "run-1" as never,
          latestRunRequestedAt: at(-500),
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-ThreadSettlementService.QUEUED_TURN_START_GRACE_MS - 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(ThreadSettlementService.QUEUED_TURN_START_GRACE_MS + 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-1_000), status: "failed" }),
        NOW_MS,
      ),
    ).toBe(false);
  });
});

interface HarnessOptions {
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly onScriptRun?: (
    input: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<void>;
  readonly onCloseIdle?: () => Effect.Effect<void>;
  readonly currentThreads?: ReadonlyArray<OrchestrationV2AppThread>;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  // Replay covers events published before the service subscribes.
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>({ replay: 16 });
  const closedIdle = yield* Queue.unbounded<{ readonly threadId: string }>();
  const scriptRuns =
    yield* Queue.unbounded<ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput>();

  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThread: (threadId) => {
        const thread = options.currentThreads?.find((candidate) => candidate.id === threadId);
        return thread
          ? Effect.succeed(thread)
          : Effect.die(new Error(`Unexpected thread read: ${threadId}`));
      },
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromPubSub(domainEvents),
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      closeOnSettle: (input) =>
        Queue.offer(closedIdle, input).pipe(Effect.andThen(options.onCloseIdle?.() ?? Effect.void)),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: (input) =>
        Queue.offer(scriptRuns, input).pipe(
          Effect.andThen(options.onScriptRun?.(input) ?? Effect.void),
          Effect.as({ status: "no-script" } as const),
        ),
    }),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(options.existingWorktreePaths?.includes(path) ?? false),
    }),
  );

  return {
    closedIdle,
    scriptRuns,
    publishEvent: (event: OrchestrationV2DomainEvent) => PubSub.publish(domainEvents, event),
    layer: Layer.effect(
      ThreadSettlementService.ThreadSettlementServiceV2,
      ThreadSettlementService.make,
    ).pipe(Layer.provide(layerDependencies)),
  };
});

describe("ThreadSettlementServiceV2 terminals", () => {
  const appThread = (
    id: string,
    settledOverride: OrchestrationV2AppThread["settledOverride"],
    worktreePath: string | null = null,
  ): OrchestrationV2AppThread => {
    const threadId = ThreadId.make(id);
    return {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: PROJECT_ID,
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: DateTime.makeUnsafe(NOW),
      updatedAt: DateTime.makeUnsafe(NOW),
      archivedAt: null,
      settledOverride,
      settledAt: settledOverride === "settled" ? DateTime.makeUnsafe(NOW) : null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };
  const settledEvent = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
    type: "thread.settled",
    id: EventId.make(`event:settled:${thread.id}`),
    threadId: thread.id,
    occurredAt: DateTime.makeUnsafe(NOW),
    payload: thread,
  });

  it.effect("closes the thread's idle terminals when it settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = appThread("settled-thread", "settled");
        const fixture = yield* makeHarness({
          currentThreads: [thread],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          yield* fixture.publishEvent(settledEvent(thread));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: thread.id });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps the terminals of a thread re-engaged before the event ran", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = appThread("reengaged-thread", "settled");
        const reengaged = appThread("reengaged-thread", "active");
        const marker = appThread("marker-thread", "settled");
        const fixture = yield* makeHarness({
          currentThreads: [reengaged, marker],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          yield* fixture.publishEvent(settledEvent(settled));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: marker.id });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("runs the settle script in the thread's own worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = appThread("shared-checkout-thread", "settled");
        const missing = appThread("removed-worktree-thread", "settled", "/worktrees/removed");
        const worktree = appThread("worktree-thread", "settled", "/worktrees/thread");
        const fixture = yield* makeHarness({
          currentThreads: [shared, missing, worktree],
          existingWorktreePaths: ["/worktrees/thread"],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          yield* fixture.publishEvent(settledEvent(shared));
          yield* fixture.publishEvent(settledEvent(missing));
          yield* fixture.publishEvent(settledEvent(worktree));
          const run = yield* Queue.take(fixture.scriptRuns);
          assert.strictEqual(run.threadId, worktree.id);
          assert.strictEqual(run.worktreePath, "/worktrees/thread");
          assert.strictEqual(run.trigger, "settle");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips the settle script for a thread re-engaged while its shells close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = appThread("reengaging-thread", "settled", "/worktrees/reengaging");
        const marker = appThread("marker-thread", "settled", "/worktrees/marker");
        const currentThreads = [settled, marker];
        const fixture = yield* makeHarness({
          currentThreads,
          existingWorktreePaths: ["/worktrees/reengaging", "/worktrees/marker"],
          onCloseIdle: () =>
            Effect.sync(() => {
              currentThreads[0] = { ...settled, settledOverride: "active" };
            }),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          yield* fixture.publishEvent(settledEvent(settled));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("runs the settle script once when a settlement is re-emitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repeated = appThread("repeated-thread", "settled", "/worktrees/repeated");
        const marker = appThread("marker-thread", "settled", "/worktrees/marker");
        const fixture = yield* makeHarness({
          currentThreads: [repeated, marker],
          existingWorktreePaths: ["/worktrees/repeated", "/worktrees/marker"],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          yield* fixture.publishEvent(settledEvent(repeated));
          yield* fixture.publishEvent(settledEvent(repeated));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, repeated.id);
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("retries the settle script on a re-emitted settlement after a failed start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = appThread("failed-start-thread", "settled", "/worktrees/failed-start");
        const starts = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          currentThreads: [thread],
          existingWorktreePaths: ["/worktrees/failed-start"],
          onScriptRun: () =>
            Ref.updateAndGet(starts, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1 ? Effect.die(new Error("terminal failed to open")) : Effect.void,
              ),
            ),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          yield* fixture.publishEvent(settledEvent(thread));
          yield* fixture.publishEvent(settledEvent(thread));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, thread.id);
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, thread.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("isSnoozed", () => {
  const snoozed = { snoozedAt: at(-2 * DAY_MS), snoozedUntil: at(DAY_MS) };
  it("defers existing input while new questions and approvals wake the thread", () => {
    const request = {
      id: RuntimeRequestId.make("question"),
      kind: "user_input" as const,
      createdAt: snoozed.snoozedAt,
    };
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, pendingRuntimeRequest: request }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, pendingRuntimeRequest: { ...request, createdAt: at(-DAY_MS) } }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, pendingRuntimeRequest: { ...request, kind: "command" } }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, snoozedAt: null, pendingRuntimeRequest: request }),
        NOW_MS,
      ),
    ).toBe(false);
  });
  it("keeps a run requested and completed after snoozing parked until the timer", () => {
    const thread = shell({
      ...snoozed,
      status: "completed",
      latestRunRequestedAt: at(-2 * DAY_MS + 1),
      latestRunStartedAt: at(-DAY_MS - 1),
      latestRunCompletedAt: at(-DAY_MS),
    });

    expect(ThreadSettlementService.isSnoozed(thread, NOW_MS)).toBe(true);
    expect(
      ThreadSettlementService.isSnoozed(shell({ ...snoozed, snoozedUntil: at(-1) }), NOW_MS),
    ).toBe(false);
  });
});

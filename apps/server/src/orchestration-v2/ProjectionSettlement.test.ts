import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isSnoozed } from "./ThreadSettlementService.ts";

const layerSql = ProjectionStore.layer.pipe(
  Layer.provide(NodeCrypto.layerDigest),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
const old = DateTime.subtract(now, { days: 10 });
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:settlement:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:settlement"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: old,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"] = "completed",
  ordinal = 1,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* store.apply({
    id: EventId.make(`event:${runId}`),
    type: "run.created",
    threadId,
    occurredAt: old,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: old,
      startedAt: status === "queued" ? null : old,
      completedAt: ["completed", "rolled_back", "failed"].includes(status) ? old : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  return runId;
});

it.effect.each([["sql", layerSql]] as const)(
  "%s: pending approvals wake a snoozed question even with older creation times",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* createThread("snoozed-question-approval", {
        snoozedAt: now,
        snoozedUntil: DateTime.add(now, { days: 1 }),
      });
      const question: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("question"),
        nodeId: NodeId.make("node:question"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: DateTime.subtract(now, { hours: 1 }),
        resolvedAt: null,
      };
      const approval: OrchestrationV2RuntimeRequest = {
        ...question,
        id: RuntimeRequestId.make("approval"),
        kind: "command",
        createdAt: old,
      };
      const newerApproval = {
        ...approval,
        id: RuntimeRequestId.make("newer-approval"),
        createdAt: DateTime.add(old, { hours: 1 }),
      };
      const setRequest = (request: OrchestrationV2RuntimeRequest) =>
        store.apply({
          id: EventId.make(`event:${request.id}:${request.status}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: request,
        });
      const assertPending = (expected: RuntimeRequestId, snoozed: boolean) =>
        Effect.gen(function* () {
          const snapshot = yield* store.getShellSnapshot();
          const shell = snapshot.threads.find((thread) => thread.id === threadId)!;
          const projection = yield* store.getThreadProjection(threadId);
          for (const candidate of [shell, ProjectionStore.threadShellFromProjection(projection)]) {
            assert.equal(candidate.pendingRuntimeRequest?.id, expected);
            assert.equal(isSnoozed(candidate, DateTime.toEpochMillis(now)), snoozed);
          }
        });
      yield* setRequest({
        ...question,
        id: RuntimeRequestId.make("older-question"),
        createdAt: old,
      });
      yield* setRequest(question);
      yield* assertPending(question.id, true);

      // A request becoming pending can retain a creation time older than the snooze.
      yield* setRequest(approval);
      yield* assertPending(approval.id, false);
      yield* setRequest(newerApproval);
      yield* assertPending(newerApproval.id, false);
      yield* setRequest({ ...newerApproval, status: "resolved", resolvedAt: now });
      yield* assertPending(approval.id, false);
      yield* setRequest({ ...approval, status: "resolved", resolvedAt: now });
      yield* assertPending(question.id, true);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("sql: the user-authored message time ignores agent notifications", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createThread("agent-woken");
    yield* createRun(threadId);
    const message = (
      id: string,
      createdBy: "user" | "agent",
      creationSource: "web" | "mcp" | "provider",
      at: DateTime.Utc,
    ) =>
      store.apply({
        id: EventId.make(`event:settlement:${id}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy,
          creationSource,
          id: MessageId.make(`message:settlement:${id}`),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: id,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      });
    const written = DateTime.subtract(now, { hours: 2 });
    const sent = DateTime.subtract(now, { hours: 1 });
    yield* message("written", "user", "web", written);
    yield* message("sent", "agent", "mcp", sent);
    yield* message("notification", "agent", "provider", now);

    // The user-authored stamp orders the Working section.
    const shellThread = (yield* store.getShellSnapshot()).threads.find(
      (thread) => thread.id === threadId,
    );
    assert.equal(DateTime.formatIso(shellThread!.latestUserMessageAt!), DateTime.formatIso(now));
    assert.equal(
      DateTime.formatIso(shellThread!.latestUserAuthoredMessageAt!),
      DateTime.formatIso(written),
    );
  }).pipe(Effect.provide(layerSql)),
);

const pullRequestLink = (number: number) => ({
  host: "github.com",
  repository: "owner/repository",
  number,
  url: `https://github.com/owner/repository/pull/${number}`,
  source: "manual" as const,
  linkedAt: DateTime.formatIso(old),
  snapshot: null,
  stack: null,
});

it.effect("sql: lists only active threads with pull request links, oldest first", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread("no-links");
    yield* createThread("empty-links", { pullRequests: [] });
    const archived = yield* createThread("archived-link", {
      archivedAt: old,
      pullRequests: [pullRequestLink(1)],
    });
    const settled = yield* createThread("settled-link", {
      settledOverride: "settled",
      settledAt: old,
      updatedAt: DateTime.subtract(now, { days: 12 }),
      pullRequests: [pullRequestLink(2)],
    });
    const open = yield* createThread("open-link", {
      pullRequests: [pullRequestLink(3), pullRequestLink(4)],
    });

    const statements: Array<string> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") statements.push(query);
        };
        return span;
      },
    });
    const threads = yield* store.getThreadsWithPullRequests().pipe(Effect.withTracer(tracer));
    const [sweepQuery] = statements.filter((statement) =>
      statement.includes("FROM orchestration_v2_projection_threads"),
    );
    assert.isDefined(sweepQuery);
    const sql = yield* SqlClient.SqlClient;
    // The minute sweeps walk the active shell index in order instead of scanning and sorting.
    const plan = (yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${sweepQuery}`,
    ))
      .map((row) => row.detail)
      .join("\n");
    assert.include(plan, "orchestration_v2_projection_threads_active_shell_idx");
    assert.notInclude(plan, "TEMP B-TREE");
    assert.deepEqual(
      threads.map((thread) => [thread.id, thread.settledOverride, thread.pullRequests?.length]),
      [
        [settled, "settled", 1],
        [open, null, 2],
      ],
    );
    assert.deepEqual(
      (yield* store.getThreadsWithPullRequests(open)).map((thread) => thread.id),
      [open],
    );
    assert.deepEqual(
      (yield* store.getThreadsWithPullRequests(undefined, { includeArchived: true })).map(
        (thread) => thread.id,
      ),
      [settled, archived, open],
    );
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: pull request sweeps decode only threads written since the last read", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const unchanged = yield* createThread("sweep-unchanged", {
      pullRequests: [pullRequestLink(1)],
    });
    const changed = yield* createThread("sweep-changed", { pullRequests: [pullRequestLink(2)] });
    const archived = yield* createThread("sweep-archived", {
      archivedAt: old,
      pullRequests: [pullRequestLink(3)],
    });
    const byId = (threads: ReadonlyArray<ProjectionStore.ProjectionThreadPullRequests>) =>
      new Map(threads.map((thread) => [thread.id, thread]));

    const first = byId(yield* store.getThreadsWithPullRequests());
    const withArchived = byId(
      yield* store.getThreadsWithPullRequests(undefined, { includeArchived: true }),
    );
    // The other variant reuses rows it shares with the active read.
    assert.strictEqual(withArchived.get(unchanged), first.get(unchanged));
    assert.isDefined(withArchived.get(archived));

    yield* createThread("sweep-changed", {
      pullRequests: [pullRequestLink(2), pullRequestLink(4)],
    });
    const sweepSpans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        if (span.name === "ProjectionStore.getThreadsWithPullRequests") sweepSpans.push(span);
        return span;
      },
    });
    const second = byId(yield* store.getThreadsWithPullRequests().pipe(Effect.withTracer(tracer)));
    assert.deepEqual(
      [
        "orchestration_v2.projection_row_count",
        "orchestration_v2.decode_cache_hit_count",
        "orchestration_v2.decode_cache_miss_count",
      ].map((key) => sweepSpans[0]?.attributes.get(key)),
      [2, 1, 1],
    );
    assert.strictEqual(second.get(unchanged), first.get(unchanged));
    assert.notStrictEqual(second.get(changed), first.get(changed));
    assert.deepEqual(
      second.get(changed)?.pullRequests?.map((link) => link.number),
      [2, 4],
    );
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: pull request sweeps evict threads that leave both variants", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const leaving = yield* createThread("sweep-leaving", { pullRequests: [pullRequestLink(1)] });
    const readBoth = Effect.gen(function* () {
      const active = yield* store.getThreadsWithPullRequests();
      yield* store.getThreadsWithPullRequests(undefined, { includeArchived: true });
      return active.find((thread) => thread.id === leaving);
    });

    const first = yield* readBoth;
    assert.isDefined(first);
    yield* createThread("sweep-leaving", { pullRequests: [] });
    assert.isUndefined(yield* readBoth);

    // The identical payload returns, so only an evicted entry decodes afresh.
    yield* createThread("sweep-leaving", { pullRequests: [pullRequestLink(1)] });
    const restored = yield* readBoth;
    assert.deepEqual(restored, first);
    assert.notStrictEqual(restored, first);
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: an unsettled-only shell read skips settled threads", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const open = yield* createThread("unsettled-open");
    const reopened = yield* createThread("unsettled-reopened", { settledOverride: "active" });
    yield* createThread("unsettled-manual", { settledOverride: "settled", settledAt: old });
    yield* createThread("unsettled-auto", { settledAt: old });
    yield* createThread("unsettled-archived", { archivedAt: old });

    const shell = yield* store.getShellSnapshot({ location: "active", unsettledOnly: true });
    assert.deepEqual(new Set(shell.threads.map((thread) => thread.id)), new Set([open, reopened]));
    assert.equal(shell.archivedThreads.length, 0);
    const all = yield* store.getShellSnapshot({ location: "active" });
    assert.equal(all.threads.length, 4);
  }).pipe(Effect.provide(layerSql)),
);

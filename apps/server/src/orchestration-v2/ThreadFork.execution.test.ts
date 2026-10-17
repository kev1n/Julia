import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (
  [
    ["codex", "interrupted"],
    ["claudeAgent", "failed"],
  ] as const
).flatMap(([driverName, status]) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

  // Each failed status keeps both context modes; a completed run only forks its final messages.
  return ([status, "completed"] as const).flatMap((caseStatus) =>
    (caseStatus === "completed"
      ? (["final_messages", "without_tool_results"] as const)
      : (["full", "final_messages", "without_tool_results"] as const)
    ).map((contextMode) => ({
      driver,
      status: caseStatus,
      contextMode,
      instanceId,
      modelSelection,
      layer,
    })),
  );
});

it.effect("a persisted fork leaves PR watching with its parent until explicitly opted in", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { instanceId, modelSelection } = forkCases[0]!;
    const sourceThreadId = ThreadId.make("fork-watch-source");
    const targetThreadId = ThreadId.make("fork-watch-target");
    const sourceRunId = RunId.make("fork-watch-source-run");
    const key = { host: "github.com", repository: "example/repo", number: 1 };
    const link = { url: "https://github.com/example/repo/pull/1", source: "agent" as const };

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-watch-create"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-watch-project"),
      title: "Watching source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("fork-watch-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("fork-watch-source-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-parent-start"),
      threadId: sourceThreadId,
      ...key,
      watching: true,
      link,
    });
    const parentBefore = yield* orchestrator.getThreadShell(sourceThreadId);
    const parentWatch = parentBefore?.pullRequests?.[0]?.watch;
    assert.isDefined(parentWatch);
    assert.lengthOf(parentBefore?.pendingBackgroundTasks ?? [], 1);

    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-watch-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const fork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isNotNull(fork);
    assert.deepEqual(fork.pullRequests, [
      {
        ...key,
        ...link,
        linkedAt: parentWatch.startedAt,
        snapshot: null,
        stack: null,
      },
    ]);
    assert.deepEqual(fork.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    const stale = yield* orchestrator
      .dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("fork-watch-stale-sync"),
        threadId: targetThreadId,
        ...key,
        startedAt: parentWatch.startedAt,
        watch: parentWatch,
        wake: {
          messageId: MessageId.make("fork-watch-unwanted-wake"),
          text: "A check failed",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "A check failed",
          },
        },
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");
    assert.deepEqual((yield* orchestrator.getThreadProjection(targetThreadId)).runs, []);

    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-in"),
      threadId: targetThreadId,
      ...key,
      watching: true,
      link,
    });
    const watchingFork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isDefined(watchingFork?.pullRequests?.[0]?.watch);
    assert.notEqual(watchingFork.pullRequests[0].watch.startedAt, parentWatch.startedAt);
    assert.lengthOf(watchingFork.pendingBackgroundTasks ?? [], 1);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-out"),
      threadId: targetThreadId,
      ...key,
      watching: false,
    });
    const stoppedFork = yield* orchestrator.getThreadShell(targetThreadId);
    const [forkLink] = fork.pullRequests ?? [];
    assert.isDefined(forkLink);
    assert.deepEqual(stoppedFork?.pullRequests, [
      { ...forkLink, endedWatch: watchingFork.pullRequests[0].watch },
    ]);
    assert.deepEqual(stoppedFork?.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect.each(forkCases)(
  "bounds $driver $contextMode context when continuing a fork of a $status run",
  ({ driver, status, contextMode, instanceId, modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      if (status === "interrupted") {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: sourceRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      for (const ordinal of [1, 2]) {
        const runId = ordinal === 1 ? sourceRunId : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${ordinal}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: ordinal === 1 && status === "interrupted" ? attemptId : null,
                status: ordinal === 1 ? status : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${ordinal}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${ordinal}`),
                threadId: sourceThreadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: ordinal === 1 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      const baseItem = {
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      for (const [index, text] of [
        "EXCLUDED_COMMENTARY",
        "INCLUDED_HEADING_AND_TABLE",
        "INCLUDED_FINAL_REPLY",
      ].entries()) {
        if (index === 1) {
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("reasoning"),
                type: "turn-item.updated",
                threadId: sourceThreadId,
                runId: sourceRunId,
                occurredAt: now,
                payload: {
                  ...baseItem,
                  id: TurnItemId.make("reasoning"),
                  ordinal: 11,
                  type: "reasoning",
                  text: "EXCLUDED_REASONING",
                  streaming: false,
                },
              },
            ],
          });
          for (const tool of [
            {
              id: "command-call",
              ordinal: 12,
              type: "command_execution",
              input: "INCLUDED_COMMAND_INPUT",
              output: "EXCLUDED_COMMAND_OUTPUT",
              outputOmitted: true,
              exitCode: 0,
            },
            {
              id: "dynamic-call",
              ordinal: 13,
              type: "dynamic_tool",
              toolName: "INCLUDED_TOOL_NAME",
              input: { query: "INCLUDED_TOOL_INPUT" },
              output: { text: "EXCLUDED_TOOL_OUTPUT", image: "EXCLUDED_SCREENSHOT" },
              viewedImagePath: "/tmp/EXCLUDED_SCREENSHOT.png",
            },
            {
              id: "file-edit",
              ordinal: 14,
              type: "file_change",
              fileName: "INCLUDED_FILE_NAME",
              diffStr: "EXCLUDED_DIFF",
              oldStr: "EXCLUDED_OLD",
              newStr: "EXCLUDED_NEW",
            },
          ] as const) {
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make(tool.id),
                  type: "turn-item.updated",
                  threadId: sourceThreadId,
                  runId: sourceRunId,
                  occurredAt: now,
                  payload: { ...baseItem, ...tool, id: TurnItemId.make(tool.id) },
                },
              ],
            });
          }
        }
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`reply-${index}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                ...baseItem,
                id: TurnItemId.make(`reply-${index}`),
                ordinal: 10 + index * 10,
                type: "assistant_message",
                messageId: MessageId.make(`reply-${index}`),
                text,
                streaming: false,
              },
            },
          ],
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        destination: "thread",
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
        contextMode,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.include(history, "INCLUDED_FINAL_REPLY");
      assert.include(history, "INCLUDED_HEADING_AND_TABLE");
      if (contextMode === "final_messages") {
        assert.notInclude(history, "EXCLUDED_COMMENTARY");
        assert.notInclude(history, "EXCLUDED_REASONING");
      } else {
        assert.include(history, "EXCLUDED_COMMENTARY");
      }
      assert.isNull(target.providerThreads[0]?.forkedFrom);
      assert.equal(target.thread.worktreePath, null);
      assert.equal(target.thread.chatGroupId, targetThreadId);
      const inherited = target.visibleTurnItems.filter((row) => row.visibility === "inherited");
      assert.deepEqual(
        inherited.map((row) => row.item.id),
        [
          TurnItemId.make("item-1"),
          ...(contextMode !== "final_messages" ? [TurnItemId.make("reply-0")] : []),
          ...(contextMode === "full" ? [TurnItemId.make("reasoning")] : []),
          ...(contextMode !== "final_messages"
            ? [
                TurnItemId.make("command-call"),
                TurnItemId.make("dynamic-call"),
                TurnItemId.make("file-edit"),
              ]
            : []),
          TurnItemId.make("reply-1"),
          TurnItemId.make("reply-2"),
        ],
      );
      if (contextMode === "without_tool_results") {
        const context = `${handoff.summaryText}\n${history}`;
        assert.include(context, "EXCLUDED_COMMENTARY");
        assert.include(context, "INCLUDED_COMMAND_INPUT");
        assert.include(context, "INCLUDED_TOOL_NAME");
        assert.include(context, "INCLUDED_TOOL_INPUT");
        assert.notInclude(context, "EXCLUDED_REASONING");
        for (const excluded of [
          "EXCLUDED_COMMAND_OUTPUT",
          "EXCLUDED_TOOL_OUTPUT",
          "EXCLUDED_SCREENSHOT",
          "EXCLUDED_DIFF",
          "EXCLUDED_OLD",
          "EXCLUDED_NEW",
        ]) {
          assert.notInclude(context, excluded);
          assert.notInclude(JSON.stringify(inherited), excluded);
        }
        const source = yield* orchestrator.getThreadProjection(sourceThreadId);
        assert.include(JSON.stringify(source.turnItems), "EXCLUDED_TOOL_OUTPUT");
      }
      const shell = yield* orchestrator.getThreadShell(targetThreadId);
      assert.equal(shell?.chatGroupId, targetThreadId);
      assert.equal(shell?.visibleItemCount, target.visibleTurnItems.length);
      const page = yield* orchestrator.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 100,
      });
      assert.deepEqual(
        page.items.filter((row) => row.visibility === "inherited").map((row) => row.item.id),
        inherited.map((row) => row.item.id),
      );
      if (contextMode === "without_tool_results") {
        assert.notInclude(JSON.stringify(page.items), "EXCLUDED_TOOL_OUTPUT");
        assert.notInclude(JSON.stringify(page.items), "EXCLUDED_COMMAND_OUTPUT");
        assert.notInclude(JSON.stringify(page.items), "EXCLUDED_DIFF");
        assert.notInclude(JSON.stringify(page.items), "EXCLUDED_REASONING");
      }
      if (contextMode !== "full" && status === "completed") {
        const localRun = target.runs[0]!;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("target-completed"),
              type: "run.updated",
              threadId: targetThreadId,
              runId: localRun.id,
              occurredAt: now,
              payload: { ...localRun, status: "completed", completedAt: now },
            },
          ],
        });
        for (const [index, text] of ["EXCLUDED_FORK_COMMENTARY", "INCLUDED_FORK_FINAL"].entries()) {
          if (index === 1) {
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("target-work"),
                  type: "turn-item.updated",
                  threadId: targetThreadId,
                  runId: localRun.id,
                  occurredAt: now,
                  payload: {
                    ...baseItem,
                    threadId: targetThreadId,
                    runId: localRun.id,
                    id: TurnItemId.make("target-work"),
                    ordinal: 11,
                    type: "reasoning",
                    text: "EXCLUDED_FORK_REASONING",
                    streaming: false,
                  },
                },
              ],
            });
          }
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`target-reply-${index}`),
                type: "turn-item.updated",
                threadId: targetThreadId,
                runId: localRun.id,
                occurredAt: now,
                payload: {
                  ...baseItem,
                  threadId: targetThreadId,
                  runId: localRun.id,
                  id: TurnItemId.make(`target-reply-${index}`),
                  ordinal: 10 + index * 10,
                  type: "assistant_message",
                  messageId: MessageId.make(`target-reply-${index}`),
                  text,
                  streaming: false,
                },
              },
            ],
          });
        }
        const descendantThreadId = ThreadId.make("fork-of-fork");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("fork-again"),
          sourceThreadId: targetThreadId,
          targetThreadId: descendantThreadId,
          sourcePoint: { type: "run", runId: localRun.id },
          contextMode,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("continue-again"),
          threadId: descendantThreadId,
          messageId: MessageId.make("continue-again"),
          text: "Continue again",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const descendant = yield* orchestrator.getThreadProjection(descendantThreadId);
        const descendantHistory = descendant.contextHandoffs[0]!.history!.messages.map(
          (message) => message.text,
        ).join("\n");
        assert.equal(descendant.thread.chatGroupId, targetThreadId);
        assert.include(descendantHistory, "INCLUDED_SOURCE_MARKER");
        assert.include(descendantHistory, "INCLUDED_HEADING_AND_TABLE");
        assert.include(descendantHistory, "INCLUDED_FINAL_REPLY");
        assert.include(descendantHistory, "INCLUDED_FORK_FINAL");
        if (contextMode === "final_messages") {
          assert.notInclude(descendantHistory, "EXCLUDED_COMMENTARY");
          assert.notInclude(descendantHistory, "EXCLUDED_FORK_COMMENTARY");
        } else {
          assert.include(descendantHistory, "EXCLUDED_COMMENTARY");
          assert.include(descendantHistory, "EXCLUDED_FORK_COMMENTARY");
          assert.include(descendantHistory, "INCLUDED_TOOL_INPUT");
          assert.notInclude(descendantHistory, "EXCLUDED_REASONING");
          assert.notInclude(descendantHistory, "EXCLUDED_FORK_REASONING");
          assert.notInclude(descendantHistory, "EXCLUDED_TOOL_OUTPUT");
        }
        assert.notInclude(descendantHistory, "EXCLUDED_LATER_MARKER");
        const descendantPage = yield* orchestrator.getTimelinePage(descendantThreadId, {
          view: "activity",
          limit: 100,
        });
        assert.deepEqual(descendantPage.items, descendant.visibleTurnItems);
        assert.equal(
          (yield* orchestrator.getThreadShell(descendantThreadId))?.visibleItemCount,
          descendantPage.totalItems,
        );
        assert.equal(
          (yield* orchestrator.getShellSnapshot()).threads.find(
            (thread) => thread.id === descendantThreadId,
          )?.visibleItemCount,
          descendantPage.totalItems,
        );
      }
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { execution: "portable_context", rejected: true },
  { execution: "native_fork", rejected: false },
] as const)(
  "a $execution fork's first /compact is rejected only when no history reaches it: $rejected",
  ({ execution, rejected }) => {
    const opened: Array<ProviderInstanceId> = [];
    const adapter = (driverName: "claudeAgent" | "codex") => {
      const driver = ProviderDriverKind.make(driverName);
      const instanceId = ProviderInstanceId.make(driverName);
      return {
        instanceId,
        driver,
        getCapabilities: () =>
          Effect.succeed(
            driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
          ),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.sync(() => opened.push(instanceId)).pipe(
            Effect.andThen(
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
              }),
            ),
          ),
      } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
    };
    const claude = adapter("claudeAgent");
    const target = execution === "portable_context" ? adapter("codex") : claude;
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-compact-source");
      const targetThreadId = ThreadId.make("fork-compact-target");
      const providerThreadId = ProviderThreadId.make("fork-compact-native-thread");
      const sourceRunId = RunId.make("fork-compact-source-run");
      const userMessageId = MessageId.make("fork-compact-source-message");
      const sourceSelection = { instanceId: claude.instanceId, model: "test-model" };

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("fork-compact-create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-compact-project"),
        title: "Fork compact source",
        modelSelection: sourceSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const item = {
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      } as const;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("fork-compact-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: claude.driver,
              providerInstanceId: claude.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: claude.driver,
                nativeId: "native-fork-compact-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("fork-compact-source-run"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: claude.instanceId,
              modelSelection: sourceSelection,
              providerThreadId,
              userMessageId,
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          // Each message alone exceeds the default 16k handoff budget, so a
          // portable handoff omits both whole items.
          {
            id: EventId.make("fork-compact-user-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-user-item"),
              ordinal: 1,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              messageId: userMessageId,
              text: "u".repeat(17_000),
              attachments: [],
            },
          },
          {
            id: EventId.make("fork-compact-assistant-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-assistant-item"),
              ordinal: 2,
              type: "assistant_message",
              messageId: MessageId.make("fork-compact-assistant-message"),
              text: "a".repeat(17_000),
              streaming: false,
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-compact-fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("fork-compact-compact"),
        threadId: targetThreadId,
        messageId: MessageId.make("fork-compact-compact"),
        text: "/compact",
        attachments: [],
        modelSelection: { instanceId: target.instanceId, model: "test-model" },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();

      const projection = yield* orchestrator.getThreadProjection(targetThreadId);
      if (execution === "portable_context") {
        assert.equal(projection.contextTransfers[0]?.resolution?.strategy, "portable_context");
        assert.deepEqual(projection.contextHandoffs[0]?.history?.messages, []);
      } else {
        assert.isEmpty(projection.contextHandoffs);
      }
      const emptyCompaction = projection.turnItems.some(
        (turnItem) =>
          turnItem.type === "error" &&
          turnItem.failure.message === "Start a conversation before compacting this thread.",
      );
      assert.equal(emptyCompaction, rejected);
      assert.deepEqual(opened, rejected ? [] : [target.instanceId]);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: `fork-compact-${execution}` },
          ProviderAdapterRegistry.layerFromAdapters(
            target === claude ? [claude] : [claude, target],
          ),
        ),
      ),
    );
  },
);

// A usage-limit continuation (fork/limitFailover.ts) forks a snoozed routine thread and sends it
// "continue"; both commands ask to keep the snooze, so the continuation never reaches the inbox.
it.effect("a fork that keeps snoozing stays snoozed through its first message", () => {
  const { instanceId, modelSelection, layer } = forkCases[0]!;
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const sourceThreadId = ThreadId.make("snoozed-routine");
    const targetThreadId = ThreadId.make("snoozed-routine-continued");
    const sourceRunId = RunId.make("snoozed-routine-run");
    const wakeAt = DateTime.add(now, { hours: 24 });
    const providerThreadId = ProviderThreadId.make("snoozed-routine-native-thread");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-snoozed-routine"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("snoozed-routine-project"),
      title: "Routine",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      snoozedUntil: DateTime.formatIso(wakeAt),
      createdBy: "user",
      creationSource: "server",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("snoozed-routine-provider-thread"),
          type: "provider-thread.updated",
          threadId: sourceThreadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: forkCases[0]!.driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: sourceThreadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: forkCases[0]!.driver,
              nativeId: "native-routine",
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("snoozed-routine-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make("snoozed-routine-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "failed",
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-snoozed-routine"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      keepSnoozed: true,
      createdBy: "system",
      creationSource: "server",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("continue-snoozed-routine"),
      threadId: targetThreadId,
      messageId: MessageId.make("continue-snoozed-routine"),
      text: "Continue",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      keepSnoozed: true,
      createdBy: "user",
      creationSource: "server",
    });
    const target = yield* orchestrator.getThreadProjection(targetThreadId);
    assert.deepEqual(target.thread.snoozedUntil, wakeAt);
  }).pipe(Effect.provide(layer));
});

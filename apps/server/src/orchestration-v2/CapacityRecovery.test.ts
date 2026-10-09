import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { continueCapacityLimitedChild } from "./CapacityRecovery.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const now = DateTime.makeUnsafe(NOW);
const threadId = ThreadId.make("child");
const driver = ProviderDriverKind.make("codex");
const instanceA = ProviderInstanceId.make("a");
const instanceB = ProviderInstanceId.make("b");
const source: OrchestrationV2Run = {
  id: RunId.make("source"),
  threadId,
  ordinal: 1,
  providerInstanceId: instanceA,
  modelSelection: { instanceId: instanceA, model: "gpt-6-astra" },
  providerThreadId: ProviderThreadId.make("provider-child"),
  userMessageId: MessageId.make("user"),
  rootNodeId: NodeId.make("root"),
  activeAttemptId: null,
  status: "failed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
};
const account = (
  instanceId: ProviderInstanceId,
  model = source.modelSelection.model,
): ServerProvider => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: DateTime.formatIso(now),
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const cases = [
  { name: "switches without a reset time despite a stale healthy snapshot", expected: instanceB },
  {
    name: "does not substitute an account without the requested model",
    incompatible: true,
    expected: null,
  },
  {
    name: "does not substitute an account without a registered adapter",
    noAdapter: true,
    expected: null,
  },
  { name: "retries a generic 429 on the same account", transient: true, expected: instanceA },
  { name: "limits transient retry to one continuation", transient: true, prior: 1, expected: null },
  { name: "excludes every previously failed account", prior: 1, expected: null },
  {
    name: "bounds the number of continuation attempts",
    prior: 3,
    thirdAccount: true,
    expected: null,
  },
  { name: "honors the persisted episode deadline", expired: true, expected: null },
  { name: "does not restart a source reached by Stop", stopped: true, expected: null },
  { name: "does not retry after a newer user turn", superseded: true, expected: null },
  {
    name: "does not retry an already accepted continuation",
    alreadyDispatched: true,
    expected: null,
  },
  { name: "does not retry when automatic failover is off", disabled: true, expected: null },
] as const;

describe("bounded child capacity recovery", () => {
  it.effect.each(cases)("$name", (test) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const config: {
        name: string;
        transient?: boolean;
        prior?: number;
        incompatible?: boolean;
        noAdapter?: boolean;
        expired?: boolean;
        stopped?: boolean;
        superseded?: boolean;
        alreadyDispatched?: boolean;
        disabled?: boolean;
        thirdAccount?: boolean;
      } = test;
      const commands = yield* Ref.make<OrchestrationV2ServerCommand[]>([]);
      const released = yield* Ref.make(0);
      const priorRuns: OrchestrationV2Run[] = Array.from(
        { length: config.prior ?? 0 },
        (_, index) => ({
          ...source,
          id: RunId.make(`previous-${index}`),
          ordinal: index + 1,
          providerInstanceId: instanceB,
          completedAt: DateTime.makeUnsafe(NOW - (config.expired ? 600_000 : 1_000)),
          ...(index === 0
            ? {}
            : { capacityContinuationOfRunId: RunId.make(`previous-${index - 1}`) }),
        }),
      );
      const current = {
        ...source,
        ordinal: priorRuns.length + 1,
        completedAt:
          config.expired && priorRuns.length === 0 ? DateTime.makeUnsafe(NOW - 600_000) : now,
        ...(priorRuns.length === 0 ? {} : { capacityContinuationOfRunId: priorRuns.at(-1)!.id }),
      };
      const error = makeProviderFailureTurnItem({
        driver,
        threadId,
        runId: current.id,
        nodeId: current.rootNodeId,
        providerThreadId: current.providerThreadId!,
        providerTurnId: ProviderTurnId.make("turn"),
        itemOrdinal: 1,
        occurredAt: now,
        failure: makeProviderFailure({
          class: config.transient ? "provider_error" : "usage_limit",
          code: config.transient ? "api_error_429" : "blocking_limit",
          message: "Limited",
          retryable: true,
        }),
      });
      const projection = {
        thread: {
          id: threadId,
          lineage: { relationshipToParent: "subagent" },
          providerInstanceId: instanceA,
          archivedAt: null,
          deletedAt: null,
          settledOverride: null,
        },
        messages: config.alreadyDispatched
          ? [{ id: MessageId.make(`message:capacity-continuation:${source.id}`) }]
          : [],
        runs: [
          ...priorRuns,
          current,
          ...(config.superseded
            ? [
                {
                  ...current,
                  id: RunId.make("newer"),
                  ordinal: current.ordinal + 1,
                  status: "completed" as const,
                },
              ]
            : []),
        ],
        turnItems: [
          error,
          ...(config.stopped ? [{ type: "run_interrupt_request", runId: current.id }] : []),
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const layer = Layer.mergeAll(
        ServerSettings.layerTest({ continueLimitedThreadsElsewhere: !config.disabled }),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([
            account(instanceA),
            account(instanceB, config.incompatible ? "other-model" : undefined),
            ...(config.thirdAccount ? [account(ProviderInstanceId.make("c"))] : []),
          ]),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () =>
            Effect.succeed(
              config.noAdapter ? [instanceA] : [instanceA, instanceB, ProviderInstanceId.make("c")],
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          dispatch: (command) =>
            Ref.update(commands, (items) => [...items, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
          recoverDelegatedTask: () => Ref.update(released, (count) => count + 1),
        }),
      );
      const run = continueCapacityLimitedChild({ threadId, sourceRunId: source.id }).pipe(
        Effect.provide(layer),
      );
      yield* run;
      const dispatched = yield* Ref.get(commands);
      if (test.expected === null) assert.isEmpty(dispatched);
      else {
        assert.equal(dispatched.length, 1);
        const command = dispatched[0]!;
        assert.ok(command.type === "message.dispatch");
        assert.equal(command.threadId, threadId);
        assert.equal(command.modelSelection?.instanceId, test.expected);
        assert.equal(command.modelSelection?.model, source.modelSelection.model);
        assert.equal(command.capacityContinuationOfRunId, source.id);
        // A replay uses the same receipt/message identity, not another task.
        yield* run;
        assert.equal((yield* Ref.get(commands))[1]?.commandId, command.commandId);
      }
      assert.isAtLeast(yield* Ref.get(released), 1);
    }).pipe(Effect.provide(IdAllocator.layer)),
  );
});

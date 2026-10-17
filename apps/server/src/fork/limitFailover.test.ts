import { assert, describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { limitRecoveryCommand } from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import { continueLimitedThreadElsewhere, limitFailoverModelSelection } from "./limitFailover.ts";

const NOW = Date.parse("2026-10-08T05:00:00Z");
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

function account(instanceId: string, driver: string, weeklyUsed: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(NOW),
    models: [
      {
        slug: driver === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5",
        name: "Model",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(NOW),
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: weeklyUsed,
          resetsAt: iso(NOW + 3 * 86_400_000),
        },
      ],
    },
  };
}

const OPUS: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};
const GPT: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const SETTING = [OPUS, GPT];
const LIMITED = ProviderInstanceId.make("claudeAgent");

describe("limitFailoverModelSelection", () => {
  it("moves to another Claude account, even when the limited one's snapshot is stale", () => {
    const providers = [
      account("claudeAgent", "claudeAgent", 0),
      account("claude_alice", "claudeAgent", 30),
      account("codex", "codex", 0),
    ];
    expect(limitFailoverModelSelection(SETTING, providers, LIMITED, NOW)).toEqual({
      instanceId: "claude_alice",
      model: "claude-opus-5-5",
    });
  });

  it("falls back to GPT-6.1 Sol when the limited account is the only Claude one left", () => {
    const providers = [
      account("claudeAgent", "claudeAgent", 0),
      account("claude_alice", "claudeAgent", 98),
      account("codex", "codex", 10),
    ];
    expect(limitFailoverModelSelection(SETTING, providers, LIMITED, NOW)).toEqual(GPT);
  });

  it("has nowhere to go when every other account is limited", () => {
    const providers = [account("claudeAgent", "claudeAgent", 0), account("codex", "codex", 100)];
    expect(limitFailoverModelSelection(SETTING, providers, LIMITED, NOW)).toBeNull();
  });
});

describe("continueLimitedThreadElsewhere", () => {
  const threadId = ThreadId.make("thread:limited");
  const runId = RunId.make("run:limited");
  const resetAt = iso(NOW + 3_600_000);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: threadId,
    status: "failed",
    lastErrorClass: "usage_limit",
    latestRunId: runId,
    usageLimitResetAt: resetAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    latestRunCompletedAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    limitRecovery: null,
    snoozedUntil: null,
  };
  const providers = [account("claudeAgent", "claudeAgent", 100), account("codex", "codex", 0)];

  const run = (
    input: ProjectionStore.ProjectionLimitRecoveryCandidate,
    relationshipToParent: "fork" | "subagent" | null = null,
    unresolvedDelegate: "running" | "completed" | false = false,
    {
      at = NOW,
      reject = () => false,
    }: { at?: number; reject?: (command: OrchestrationV2ServerCommand) => boolean } = {},
  ) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at);
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const source = {
        title: "Fix the sync",
        providerInstanceId: LIMITED,
        lineage: { parentThreadId: null, relationshipToParent, rootThreadId: threadId },
      } as unknown as OrchestrationV2AppThread;
      const continued = yield* continueLimitedThreadElsewhere(
        input,
        SETTING,
        providers,
        {
          getThreadRecords: () =>
            Effect.succeed({
              thread: source,
              subagents: unresolvedDelegate
                ? [
                    {
                      origin: "app_owned",
                      status: unresolvedDelegate,
                      result: null,
                      completionDelivery: { state: "pending" },
                    },
                  ]
                : [],
            } as never),
        },
        {
          dispatch: (command) =>
            reject(command)
              ? Effect.die(`rejected ${command.commandId}`)
              : Effect.sync(() => {
                  dispatched.push(command);
                  return { sequence: dispatched.length, storedEvents: [] };
                }),
        },
      );
      return { continued, dispatched };
    });

  it.effect("forks into a tab on the fallback model, continues there, and disarms the source", () =>
    Effect.gen(function* () {
      const { continued, dispatched } = yield* run(candidate);
      assert.isTrue(continued);
      // The source names the new tab before that tab's first message starts it.
      const [fork, handled, message] = dispatched;
      assert.ok(fork?.type === "thread.fork");
      assert.equal(fork.sourceThreadId, threadId);
      assert.deepEqual(fork.sourcePoint, { type: "run", runId });
      assert.equal(fork.title, "Fix the sync");
      assert.isUndefined(fork.destination);
      // A snoozed routine's continuation stays snoozed, through its first message too.
      assert.isTrue(fork.keepSnoozed);
      assert.ok(message?.type === "message.dispatch");
      assert.equal(message.threadId, fork.targetThreadId);
      assert.isTrue(message.keepSnoozed);
      assert.deepEqual(message.modelSelection, GPT);
      assert.ok(handled?.type === "thread.metadata.update");
      assert.equal(handled.threadId, threadId);
      assert.deepEqual(handled.limitRecovery, {
        runId,
        resetAt,
        autoResume: false,
        snooze: false,
        continuedIn: fork.targetThreadId,
      });
    }),
  );

  it.effect.each(["running", "completed"] as const)(
    "does not fork a parent with an owed delegate result (%s)",
    (status) =>
      Effect.gen(function* () {
        const { continued, dispatched } = yield* run(candidate, null, status);
        assert.isFalse(continued);
        assert.isEmpty(dispatched);
      }),
  );

  it.effect("repeats the same commands after a sweep that died halfway", () =>
    Effect.gen(function* () {
      const first = yield* run(candidate);
      const second = yield* run(candidate);
      assert.deepEqual(
        second.dispatched.map((command) => command.commandId),
        first.dispatched.map((command) => command.commandId),
      );
    }),
  );

  it.effect(
    "retries a rejected first message after naming the new tab, under a new command id",
    () =>
      Effect.gen(function* () {
        // Orchestration keeps a rejected command's receipt and rejects its id forever.
        const rejected = new Set<string>();
        const reject = (command: OrchestrationV2ServerCommand) => {
          if (rejected.has(command.commandId)) return true;
          if (command.type !== "message.dispatch" || rejected.size > 0) return false;
          rejected.add(command.commandId);
          return true;
        };
        const failed = yield* Effect.exit(run(candidate, null, false, { reject }));
        assert.equal(failed._tag, "Failure");
        const [first] = rejected;
        const linked = {
          ...candidate,
          limitRecovery: {
            runId,
            resetAt,
            autoResume: false,
            snooze: false,
            continuedIn: ThreadId.make(first!.slice(0, first!.indexOf(":continue"))),
          },
        };
        const resumed = yield* run(linked, null, false, { at: NOW + 30_000, reject });
        assert.isTrue(resumed.continued);
        const message = resumed.dispatched.at(-1);
        assert.ok(message?.type === "message.dispatch");
        assert.equal(message.threadId, linked.limitRecovery.continuedIn);
        assert.equal(message.messageId, `${linked.limitRecovery.continuedIn}:continue`);
        assert.notEqual(message.commandId, first);
      }),
  );

  it("never resumes a source whose work a failover moved, even if re-armed", () => {
    const recovery = {
      runId,
      resetAt,
      autoResume: true,
      snooze: false,
      continuedIn: ThreadId.make("limit-failover:tab"),
    };
    const afterReset = Date.parse(resetAt) + 1;
    assert.isNotNull(
      limitRecoveryCommand(
        { ...candidate, limitRecovery: { ...recovery, continuedIn: undefined } },
        true,
        afterReset,
      ),
    );
    assert.isNull(
      limitRecoveryCommand({ ...candidate, limitRecovery: recovery }, true, afterReset),
    );
  });

  it.effect("leaves a handled run, a past limit, and a subagent to upstream's recovery", () =>
    Effect.gen(function* () {
      const handled = yield* run({
        ...candidate,
        limitRecovery: { runId, resetAt, autoResume: true, snooze: false },
      });
      assert.isFalse(handled.continued);
      assert.lengthOf(handled.dispatched, 0);
      const past = yield* run({ ...candidate, usageLimitResetAt: iso(NOW - 60_000) });
      assert.isFalse(past.continued);
      assert.lengthOf(past.dispatched, 0);
      const subagent = yield* run(candidate, "subagent");
      assert.isFalse(subagent.continued);
      assert.lengthOf(subagent.dispatched, 0);
    }),
  );
});

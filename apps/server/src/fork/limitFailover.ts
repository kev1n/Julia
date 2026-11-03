/**
 * Fork: a turn stopped on a usage limit continues in a new tab on the first
 * `limitFailoverModelSelections` account with usage left; the source's recovery is turned off and
 * it names the tab in `continuedIn` before that tab's first message. Run from the
 * UsageLimitRecoveryWorker sweep; command ids derive from the failed run, so retries repeat them.
 */
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  chooseAutoAccount,
  providerSupportsSelection,
  usableInstances,
} from "@t3tools/shared/accountChoice";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- ids must be derived synchronously.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { isForkableSourceRunStatus } from "../orchestration-v2/ThreadForkService.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export const LIMIT_FAILOVER_PROMPT =
  "Your previous turn stopped on a usage limit, so this conversation moved to another account. Continue where you left off.";

/**
 * The first model in `selections` that can run now on an account other than
 * `limitedInstanceId`, moved to the account Auto would pick for its provider.
 */
export function limitFailoverModelSelection(
  selections: ReadonlyArray<ModelSelection>,
  providers: ReadonlyArray<ServerProvider>,
  limitedInstanceId: ProviderInstanceId,
  now: number,
  eligibleInstanceIds?: ReadonlySet<ProviderInstanceId>,
): ModelSelection | null {
  for (const selection of selections) {
    const driver = providers.find(
      (provider) => provider.instanceId === selection.instanceId,
    )?.driver;
    if (!driver) continue;
    const accounts = usableInstances(providers, driver).filter(
      (provider) =>
        provider.instanceId !== limitedInstanceId &&
        (eligibleInstanceIds === undefined || eligibleInstanceIds.has(provider.instanceId)) &&
        providerSupportsSelection(provider, selection),
    );
    const choice = chooseAutoAccount(
      accounts,
      (provider) => provider.usageLimits,
      now,
      selection.model,
    );
    if (choice) return { ...selection, instanceId: choice.account.instanceId };
  }
  return null;
}

/**
 * Forks a limited thread onto another account and continues it there. Returns
 * whether it did; false leaves the thread to upstream's recovery.
 */
export const continueLimitedThreadElsewhere = Effect.fn("LimitFailover.continue")(function* (
  candidate: ProjectionStore.ProjectionLimitRecoveryCandidate,
  selections: ReadonlyArray<ModelSelection>,
  providers: ReadonlyArray<ServerProvider>,
  projections: Pick<ProjectionStore.ProjectionStoreV2["Service"], "getThreadRecords">,
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "dispatch">,
  eligibleInstanceIds?: ReadonlySet<ProviderInstanceId>,
) {
  const runId = candidate.latestRunId;
  const resetAt = candidate.usageLimitResetAt;
  const recovery = candidate.limitRecovery;
  // Already handled for this run and reset by upstream's recovery, or by a
  // failover. A failover's tab that has no first message yet is finished below.
  if (
    !runId ||
    !resetAt ||
    (recovery?.runId === runId && recovery.resetAt === resetAt && !recovery.continuedIn)
  )
    return false;
  // A limit whose reset has passed is over; old stopped threads stay as they are.
  const now = yield* Clock.currentTimeMillis;
  if (Date.parse(resetAt) <= now) return false;
  const {
    thread: source,
    subagents,
    runs,
  } = yield* projections.getThreadRecords(candidate.id, ["subagents", "runs"]);
  // A fork cannot adopt task ownership. Keep the parent here until all owed
  // results have been consumed; completion can wake it in place on another account.
  if (
    subagents.some(
      (task) =>
        task.origin === "app_owned" &&
        task.completionDelivery?.state !== "acknowledged" &&
        task.completionDelivery?.state !== "delivered" &&
        task.completionDelivery?.state !== "disposed",
    )
  )
    return false;
  // A subagent's result belongs to its parent's run; a fork would orphan it.
  if (source.lineage.relationshipToParent === "subagent") return false;
  const modelSelection = limitFailoverModelSelection(
    selections,
    providers,
    source.providerInstanceId,
    now,
    eligibleInstanceIds,
  );
  if (!modelSelection) return false;
  const moved = yield* compactionHandover(candidate.id, runId, runs, projections);

  // Hashed because thread and run ids embed their source's id: a failover of a
  // failover would otherwise nest every id and grow past filename limits.
  const identity = NodeCrypto.createHash("sha256")
    .update(`${candidate.id}:${runId}:${Date.parse(resetAt)}`)
    .digest("hex")
    .slice(0, 32);
  const targetThreadId = ThreadId.make(`limit-failover:${identity}`);
  yield* threads.dispatch({
    type: "thread.fork",
    commandId: CommandId.make(`limit-failover:${identity}`),
    sourceThreadId: candidate.id,
    targetThreadId,
    sourcePoint: { type: "run", runId: moved?.forkRunId ?? runId },
    title: source.title,
    // A routine's thread was snoozed to keep it out of the inbox; its continuation is too.
    keepSnoozed: true,
    createdBy: "system",
    creationSource: "server",
  });
  // Name the successor before it starts: the source must never look finished
  // while its work runs in a tab nothing points to.
  yield* threads.dispatch({
    type: "thread.metadata.update",
    commandId: CommandId.make(`limit-failover:${identity}:handled`),
    threadId: candidate.id,
    limitRecovery: {
      runId,
      resetAt,
      autoResume: false,
      snooze: false,
      continuedIn: targetThreadId,
    },
  });
  // One command id per attempt: a rejected dispatch is recorded under its id and
  // would be rejected again on replay. The fixed message id is what ends the
  // retries (`getLimitRecoveryCandidates` drops the source once it exists).
  const continuations = moved?.messages ?? [
    { text: LIMIT_FAILOVER_PROMPT, attachments: [], context: undefined },
  ];
  for (const [index, message] of continuations.entries()) {
    const suffix = index === 0 ? "" : `:${index}`;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`limit-failover:${identity}:continue${suffix}:${now}`),
      messageId: MessageId.make(`limit-failover:${identity}:continue${suffix}`),
      threadId: targetThreadId,
      text: message.text,
      ...(message.context === undefined ? {} : { context: message.context }),
      attachments: message.attachments,
      modelSelection,
      dispatchMode: index === 0 ? { type: "start_immediately" } : { type: "queue_after_active" },
      keepSnoozed: true,
      createdBy: "user",
      creationSource: "server",
    });
  }
  for (const queuedRun of moved?.queuedRuns ?? []) {
    yield* threads.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(`limit-failover:${identity}:moved:${queuedRun.id}`),
      threadId: candidate.id,
      runId: queuedRun.id,
    });
  }
  yield* Effect.logInfo("orchestration-v2.limit-failover.continued", {
    threadId: candidate.id,
    targetThreadId,
    instanceId: modelSelection.instanceId,
    model: modelSelection.model,
    movedQueuedMessages: moved?.queuedRuns.length ?? 0,
  });
  return true;
});

/**
 * When the limited run is a `/compact` with the user's messages queued behind
 * it: the run to fork from instead (the one before the compaction, or the
 * compaction itself when nothing precedes it) and the queued messages to send.
 * Null when the limit hit anything else.
 */
const compactionHandover = Effect.fn("LimitFailover.compactionHandover")(function* (
  threadId: ThreadId,
  limitedRunId: RunId,
  runs: ReadonlyArray<OrchestrationV2Run>,
  projections: Pick<ProjectionStore.ProjectionStoreV2["Service"], "getThreadRecords">,
) {
  const limitedRun = runs.find((run) => run.id === limitedRunId);
  if (limitedRun === undefined) return null;
  const queued = runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );
  if (queued.length === 0) return null;
  const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
    messageIds: [limitedRun.userMessageId, ...queued.map((run) => run.userMessageId)],
  });
  const messageFor = (run: OrchestrationV2Run) =>
    messages.find((message) => message.id === run.userMessageId);
  if (messageFor(limitedRun)?.text.trim().toLowerCase() !== "/compact") return null;
  // Wakes and delegated results belong to the source's own runs, not the user's send.
  const queuedRuns = queued.filter((run) => {
    const message = messageFor(run);
    return (
      message?.role === "user" &&
      message.notification === undefined &&
      message.delegatedCompletion === undefined
    );
  });
  if (queuedRuns.length === 0) return null;
  const previous = runs
    .filter((run) => run.ordinal < limitedRun.ordinal && isForkableSourceRunStatus(run.status))
    .reduce<OrchestrationV2Run | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
  return {
    forkRunId: previous?.id ?? limitedRun.id,
    queuedRuns,
    messages: queuedRuns.map((run) => {
      const { text, attachments, context } = messageFor(run)!;
      return { text, attachments, context };
    }),
  };
});

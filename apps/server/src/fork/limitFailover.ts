/**
 * Fork (Owner): continue a usage-limited thread on another subscription.
 * When a turn stops on a usage limit, the thread is forked into a new tab of
 * the same chat and told to continue there on the first of
 * `limitFailoverModelSelections` whose provider has an account with usage left
 * (on the account Auto would pick, never the limited one). The source thread's
 * limit recovery is then configured off for that run, which both records that
 * it was handled and keeps upstream's auto-resume from also resuming it, and
 * names the new tab in `continuedIn` so clients stop calling the source Limited. With no
 * account left anywhere, upstream's recovery (auto-resume, snooze) applies.
 *
 * Called from `UsageLimitRecoveryWorker`'s sweep, so it shares its persisted
 * candidates and needs no timers of its own. Every command id derives from the
 * failed run and reset, so a sweep that dies halfway repeats the same commands.
 */
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  chooseAutoAccount,
  providerSupportsSelection,
  usableInstances,
} from "@t3tools/shared/accountChoice";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
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
  // Already handled (by this or by upstream's recovery) for this run and reset.
  if (
    !runId ||
    !resetAt ||
    (candidate.limitRecovery?.runId === runId && candidate.limitRecovery.resetAt === resetAt)
  )
    return false;
  // A limit whose reset has passed is over; old stopped threads stay as they are.
  const now = yield* Clock.currentTimeMillis;
  if (Date.parse(resetAt) <= now) return false;
  const { thread: source, subagents } = yield* projections.getThreadRecords(candidate.id, [
    "subagents",
  ]);
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

  const identity = `${candidate.id}:${runId}:${Date.parse(resetAt)}`;
  const targetThreadId = ThreadId.make(`limit-failover:${identity}`);
  yield* threads.dispatch({
    type: "thread.fork",
    commandId: CommandId.make(`limit-failover:${identity}`),
    sourceThreadId: candidate.id,
    targetThreadId,
    sourcePoint: { type: "run", runId },
    title: source.title,
    createdBy: "system",
    creationSource: "server",
  });
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`limit-failover:${identity}:continue`),
    messageId: MessageId.make(`limit-failover:${identity}:continue`),
    threadId: targetThreadId,
    text: LIMIT_FAILOVER_PROMPT,
    modelSelection,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  });
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
  yield* Effect.logInfo("orchestration-v2.limit-failover.continued", {
    threadId: candidate.id,
    targetThreadId,
    instanceId: modelSelection.instanceId,
    model: modelSelection.model,
  });
  return true;
});

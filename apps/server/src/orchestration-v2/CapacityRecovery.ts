import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { latestRootProviderFailure, runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { accountWithLimitLeft } from "../fork/accountWithLimitLeft.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_DEADLINE_MS = 5 * 60_000;

/** Walk the persisted links, not an in-memory attempt counter that resets at boot. */
function capacityRecoveryEpisode(
  source: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  const episode = [source];
  const seen = new Set([source.id]);
  let previous = source.capacityContinuationOfRunId;
  while (previous !== undefined) {
    const run = runs.find((candidate) => candidate.id === previous);
    if (!run || seen.has(run.id)) return null;
    seen.add(run.id);
    episode.push(run);
    previous = run.capacityContinuationOfRunId;
  }
  return episode;
}

/** Continue an app-owned child in place; task identity and parent ownership do not move. */
export const continueCapacityLimitedChild = Effect.fn("CapacityRecovery.continue")(
  function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    if (!(yield* settings.getSettings).continueLimitedThreadsElsewhere) return;
    const messageId = MessageId.make(`message:capacity-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "turnItems"],
      {
        messageIds: [messageId],
        turnItemTypes: ["error", "run_interrupt_request"],
      },
    );
    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    if (
      !source ||
      source.status !== "failed" ||
      projection.thread.lineage.relationshipToParent !== "subagent" ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.thread.settledOverride === "settled" ||
      projection.thread.providerInstanceId !== source.providerInstanceId ||
      projection.runs.some(
        (run) => run.status !== "queued" && run.id !== source.id && runRanAfter(run, source),
      ) ||
      projection.turnItems.some(
        (item) => item.type === "run_interrupt_request" && item.runId === source.id,
      )
    )
      return;
    const failure = latestRootProviderFailure(source, projection.turnItems);
    if (failure?.class !== "usage_limit" && failure?.code !== "api_error_429") return;
    const episode = capacityRecoveryEpisode(source, projection.runs);
    const root = episode?.at(-1);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (
      !episode ||
      !root ||
      episode.length > MAX_RECOVERY_ATTEMPTS ||
      now - DateTime.toEpochMillis(root.completedAt ?? root.requestedAt) > RECOVERY_DEADLINE_MS
    )
      return;
    // A generic 429 is not proof of subscription exhaustion. Allow one delayed
    // same-account retry; providers already perform their own transport retries.
    if (failure.class !== "usage_limit" && episode.length > 1) return;
    const providers = yield* ProviderRegistry;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const snapshots = yield* providers.getProviders;
    const eligibleInstanceIds = new Set(yield* adapters.list());
    const modelSelection =
      failure.class === "usage_limit"
        ? accountWithLimitLeft(source.modelSelection, snapshots, now, {
            force: true,
            eligibleInstanceIds,
            excludedInstanceIds: new Set(episode.map((run) => run.providerInstanceId)),
          })
        : source.modelSelection;
    if (failure.class === "usage_limit" && modelSelection.instanceId === source.providerInstanceId)
      return;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:capacity-continuation:${input.sourceRunId}`),
      threadId: input.threadId,
      messageId,
      modelSelection,
      text: "Your previous turn stopped on a provider limit. Continue where you left off. Existing delegated tasks retain their IDs; do not recreate completed or still-running delegates.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      capacityContinuationOfRunId: source.id,
    });
  },
  (effect, input) =>
    effect.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          // Declining recovery must release its publication hold too.
          yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
        }),
      ),
    ),
);

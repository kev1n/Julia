import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ProviderThread,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

import type { ThreadStructure, ThreadStructureTurnItem } from "./state/models.ts";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/** Newest usage report across a thread's provider turns. Snapshots order turns
    by provider thread, not time, so pick by timestamp. */
export function latestProviderTurnTokenUsage(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "tokenUsage">>,
  projection?: Pick<ThreadStructure, "thread" | "contextTransfers"> | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "contextUsage"> | null,
): OrchestrationV2ProviderTurnTokenUsage | null {
  let latest: OrchestrationV2ProviderTurnTokenUsage | null = null;
  for (const { tokenUsage } of turns) {
    if (tokenUsage === undefined) continue;
    // Ties go to the later entry, since live upserts append.
    if (latest === null || Date.parse(tokenUsage.updatedAt) >= Date.parse(latest.updatedAt)) {
      latest = tokenUsage;
    }
  }
  if (latest !== null || projection == null || providerThread?.contextUsage != null) return latest;
  const forkedFrom = projection.thread.forkedFrom;
  // A filtered fork starts a fresh session from a handoff, so the source's size says nothing
  // about its context.
  if (forkedFrom?.type !== "run" || (forkedFrom.contextMode ?? "full") !== "full") return null;
  return (
    projection.contextTransfers.find(
      (transfer) =>
        transfer.type === "fork" &&
        transfer.targetThreadId === projection.thread.id &&
        transfer.sourceThreadId === forkedFrom.threadId &&
        transfer.sourcePoint.runId === forkedFrom.runId &&
        transfer.sourceProviderInstanceId === projection.thread.modelSelection.instanceId &&
        (transfer.status === "pending" || transfer.resolution?.strategy === "native_fork"),
    )?.sourceTokenUsage ?? null
  );
}

/** Prefers the provider's live usage report; falls back to the last compaction item. */
export function deriveLatestContextWindowSnapshot(
  entries: ReadonlyArray<{
    readonly item: ThreadStructureTurnItem;
  }>,
  liveUsage?: OrchestrationV2ProviderTurnTokenUsage | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "contextUsage" | "updatedAt"> | null,
): ContextWindowSnapshot | null {
  if (liveUsage != null) {
    const usedTokens = Math.max(0, liveUsage.usedTokens);
    const maxTokens = liveUsage.maxTokens ?? null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
    return {
      usedTokens,
      totalProcessedTokens: null,
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: liveUsage.inputTokens ?? null,
      cachedInputTokens: liveUsage.cachedInputTokens ?? null,
      outputTokens: liveUsage.outputTokens ?? null,
      reasoningOutputTokens: liveUsage.reasoningOutputTokens ?? null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold: liveUsage.autoCompactThreshold ?? null,
      cost: null,
      updatedAt: liveUsage.updatedAt,
    };
  }
  const providerUsage = providerThread?.contextUsage;
  const providerUsageUpdatedAt = providerThread?.updatedAt;
  if (
    providerUsage !== null &&
    providerUsage !== undefined &&
    providerUsageUpdatedAt !== undefined
  ) {
    const maxTokens = asFiniteNumber(providerUsage.maxTokens);
    const usedTokens = providerUsage.usedTokens;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(providerUsage.totalProcessedTokens),
      maxTokens,
      remainingTokens: maxTokens === null ? null : Math.max(0, Math.round(maxTokens - usedTokens)),
      usedPercentage,
      remainingPercentage: usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
      inputTokens: asFiniteNumber(providerUsage.inputTokens),
      cachedInputTokens: asFiniteNumber(providerUsage.cachedInputTokens),
      outputTokens: asFiniteNumber(providerUsage.outputTokens),
      reasoningOutputTokens: asFiniteNumber(providerUsage.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(providerUsage.lastUsedTokens),
      lastInputTokens: asFiniteNumber(providerUsage.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(providerUsage.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(providerUsage.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(providerUsage.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(providerUsage.toolUses),
      durationMs: asFiniteNumber(providerUsage.durationMs),
      compactsAutomatically: providerUsage.compactsAutomatically ?? null,
      cost: providerUsage.cost ?? null,
      autoCompactThreshold: providerUsage.autoCompactThreshold ?? null,
      updatedAt: DateTime.formatIso(providerUsageUpdatedAt),
    };
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.item.type !== "compaction") {
      continue;
    }
    const payload = entry.item;
    const usedTokens = asFiniteNumber(payload.afterTokenCount);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload.beforeTokenCount),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold: null,
      cost: null,
      updatedAt: DateTime.formatIso(payload.startedAt ?? payload.updatedAt),
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  // Anything from 999,500 rounds to 1000k, so it belongs to the next unit.
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** Readout precision: one decimal in every unit, so the composer's line moves as context grows. */
function formatContextWindowReadoutTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  // Anything from 999,950 rounds to 1000.0k, so it belongs to the next unit.
  if (value < 999_950) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

type ThreadContextWindowProjection = Pick<
  ThreadStructure,
  | "thread"
  | "providerThreads"
  | "providerTurns"
  | "visibleTurnItems"
  | "attempts"
  | "runs"
  | "contextTransfers"
>;

/** The newest live usage report from the current native session and model, if any. */
export function deriveThreadLiveTokenUsage(
  projection: ThreadContextWindowProjection | null | undefined,
): OrchestrationV2ProviderTurnTokenUsage | null {
  if (!projection) return null;
  const activeId = projection.thread.activeProviderThreadId;
  const providerThread =
    activeId === null
      ? undefined
      : projection.providerThreads.find((thread) => thread.id === activeId);
  return latestProviderTurnTokenUsage(
    projection.providerTurns.filter((turn) => {
      if (activeId === null || turn.providerThreadId !== activeId || turn.tokenUsage === undefined)
        return false;
      const attempt = projection.attempts.find((attempt) => attempt.id === turn.runAttemptId);
      if (
        !attempt ||
        attempt.nativeThreadId !== providerThread?.nativeThreadRef?.nativeId ||
        attempt.rootNodeId !== turn.nodeId
      )
        return false;
      const run = projection.runs.find((run) => run.id === attempt.runId);
      const selection = providerThread?.nativeMetadata?.modelSelection;
      return (
        !selection || (run !== undefined && modelSelectionsEqual(selection, run.modelSelection))
      );
    }),
    // A fresh fork reports its source's usage until its own first turn does.
    projection,
    providerThread,
  );
}

/** Keeps live reports scoped to the current native session and model. */
export function deriveThreadContextWindowSnapshot(
  projection: ThreadContextWindowProjection | null | undefined,
): ContextWindowSnapshot | null {
  if (!projection) return null;
  const activeId = projection.thread.activeProviderThreadId;
  const providerThread =
    activeId === null
      ? undefined
      : projection.providerThreads.find((thread) => thread.id === activeId);
  const liveUsage = deriveThreadLiveTokenUsage(projection);
  return deriveLatestContextWindowSnapshot(
    liveUsage || providerThread?.contextUsage || activeId === null
      ? []
      : projection.visibleTurnItems.filter(({ item }) => item.providerThreadId === activeId),
    liveUsage,
    providerThread,
  );
}

export function formatContextWindowReadout(usage: ContextWindowSnapshot | null): string {
  if (!usage) return "Context unavailable";
  const used = formatContextWindowReadoutTokens(usage.usedTokens);
  if (usage.maxTokens == null || usage.usedPercentage === null) return `Context ${used} tokens`;
  const percentage = usage.usedPercentage.toFixed(1).replace(/\.0$/, "");
  return `Context ${used}/${formatContextWindowReadoutTokens(usage.maxTokens)} · ${percentage}%`;
}

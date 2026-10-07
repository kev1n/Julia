import type { ProviderInstanceId, ServerProviderUsageLimits } from "@t3tools/contracts";
import { chooseAutoAccount } from "./accountChoice";

export interface ModelSubscription<T> {
  readonly instanceId: ProviderInstanceId;
  /** Harness/catalog identity, not its display name. */
  readonly catalog: string;
  readonly model: string;
  readonly available: boolean;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
  readonly value: T;
}

export interface ModelSubscriptionGroup<T> {
  readonly key: string;
  readonly subscriptions: ReadonlyArray<ModelSubscription<T>>;
  /** Null when all compatible subscriptions are exhausted or unavailable. */
  readonly recommended: ModelSubscription<T> | null;
}

/** Deduplicate models without merging identically named models from different catalogs. */
export function groupModelSubscriptions<T>(
  subscriptions: ReadonlyArray<ModelSubscription<T>>,
  now: number,
): ReadonlyArray<ModelSubscriptionGroup<T>> {
  const groups = new Map<string, ModelSubscription<T>[]>();
  for (const subscription of subscriptions) {
    const key = JSON.stringify([subscription.catalog, subscription.model]);
    const group = groups.get(key);
    if (group) group.push(subscription);
    else groups.set(key, [subscription]);
  }
  return [...groups].map(([key, group]) => {
    const recommended =
      chooseAutoAccount(
        group.filter((subscription) => subscription.available),
        (subscription) => subscription.usageLimits,
        now,
      )?.account ?? null;
    return {
      key,
      recommended,
      subscriptions: recommended
        ? [recommended, ...group.filter((subscription) => subscription !== recommended)]
        : group,
    };
  });
}

/** Preferred starting models, independent of account order or catalog defaults. */
export function defaultModelPriority(catalog: string, model: string): number {
  if (catalog === "claudeAgent" && model === "claude-opus-5-5") return 0;
  if (catalog === "codex" && model === "gpt-6.1-sol") return 1;
  if (catalog === "codex" && model === "gpt-6-astra") return 2;
  return 3;
}

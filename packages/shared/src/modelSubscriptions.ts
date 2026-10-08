import type {
  ModelSelection,
  ProviderInstanceId,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { chooseAutoAccount } from "./accountChoice.ts";

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

/**
 * Keep the starting model on a compatible account with capacity. When every
 * account for it is exhausted, try the preferred models and user pins instead.
 * Callers keep explicit draft selections out of this automatic choice.
 */
export function chooseNewChatModelSubscription<T>(
  selection: ModelSelection,
  subscriptions: ReadonlyArray<ModelSubscription<T>>,
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  now: number,
): ModelSubscription<T> | null {
  const groups = groupModelSubscriptions(subscriptions, now);
  const current = groups.find((group) =>
    group.subscriptions.some(
      (subscription) =>
        subscription.instanceId === selection.instanceId && subscription.model === selection.model,
    ),
  );
  if (!current) return null;
  if (current.recommended) return current.recommended;

  return (
    groups
      .map((group, index) => {
        const first = group.subscriptions[0]!;
        const priority = defaultModelPriority(first.catalog, first.model);
        const favoriteIndex = favorites.findIndex((favorite) =>
          group.subscriptions.some(
            (subscription) =>
              subscription.instanceId === favorite.provider &&
              subscription.model === favorite.model,
          ),
        );
        return { group, index, priority, favoriteIndex };
      })
      .filter((item) => item.group.recommended && (item.priority < 3 || item.favoriteIndex >= 0))
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          (a.favoriteIndex < 0 ? Infinity : a.favoriteIndex) -
            (b.favoriteIndex < 0 ? Infinity : b.favoriteIndex) ||
          a.index - b.index,
      )[0]?.group.recommended ?? null
  );
}

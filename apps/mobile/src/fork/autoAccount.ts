/**
 * Fork (Owner): a phone task's default model moves to the account Auto would use, the instance of
 * its provider with the most usage left; with all compatible accounts exhausted, the other
 * preferred or pinned models are tried. A model picked by hand in the draft stays as picked.
 */
import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { chooseNewChatModelSubscription } from "@t3tools/shared/modelSubscriptions";

export function withAutoAccount(
  selection: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
  // Re-read when the server's provider snapshots change, as the model options are.
  now: number = Date.now(),
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }> = [],
): ModelSelection | null {
  if (!selection) return selection;
  const chosen = chooseNewChatModelSubscription(
    selection,
    providers.flatMap((provider) =>
      provider.models
        .filter((model) => !model.isLegacy || model.slug === selection.model)
        .map((model) => ({
          instanceId: provider.instanceId,
          catalog:
            provider.driver === "acpRegistry"
              ? `acpRegistry:${provider.instanceId}`
              : provider.driver,
          model: model.slug,
          available:
            provider.enabled &&
            provider.installed &&
            provider.status === "ready" &&
            provider.auth.status !== "unauthenticated" &&
            isProviderAvailable(provider),
          usageLimits: provider.usageLimits,
          value: model,
        })),
    ),
    favorites,
    now,
  );
  if (!chosen || (chosen.instanceId === selection.instanceId && chosen.model === selection.model)) {
    return selection;
  }
  return chosen.model === selection.model
    ? { ...selection, instanceId: chosen.instanceId }
    : { instanceId: chosen.instanceId, model: chosen.model };
}

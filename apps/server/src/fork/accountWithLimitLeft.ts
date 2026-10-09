/** Select a compatible subscription with capacity without changing model/options. */
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  accountStanding,
  chooseAutoInstance,
  providerSupportsSelection,
  usableInstances,
} from "@t3tools/shared/accountChoice";

export function accountWithLimitLeft(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
  options: {
    readonly eligibleInstanceIds?: ReadonlySet<ProviderInstanceId>;
    readonly excludedInstanceIds?: ReadonlySet<ProviderInstanceId>;
    readonly force?: boolean;
  } = {},
): ModelSelection {
  const saved = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (!saved) return selection;
  const eligible = (provider: ServerProvider) =>
    (options.eligibleInstanceIds === undefined ||
      options.eligibleInstanceIds.has(provider.instanceId)) &&
    !options.excludedInstanceIds?.has(provider.instanceId) &&
    providerSupportsSelection(provider, selection);
  if (
    !options.force &&
    eligible(saved) &&
    usableInstances([saved], saved.driver).length > 0 &&
    !accountStanding(saved.usageLimits, now, selection.model).limited
  )
    return selection;
  const choice = chooseAutoInstance(providers.filter(eligible), saved.driver, now, selection.model);
  return choice ? { ...selection, instanceId: choice.account.instanceId } : selection;
}

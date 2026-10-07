/**
 * Fork (Owner): a scheduled task saves one account (provider instance) when it
 * is created, so a daily run kept using that account after its limits ran out.
 * When the saved account is limited or no longer usable, the run moves to the
 * account Auto would pick among this machine's instances of the same provider
 * (`chooseAutoInstance`), keeping the model and options. With no usable
 * account left, the saved one runs and fails as it would have.
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import {
  accountStanding,
  chooseAutoInstance,
  usableInstances,
} from "@t3tools/shared/accountChoice";

export function scheduledRunModelSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): ModelSelection {
  const saved = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (!saved) return selection;
  const savedUsable =
    usableInstances([saved], saved.driver).length > 0 &&
    !accountStanding(saved.usageLimits, now).limited;
  if (savedUsable) return selection;
  const choice = chooseAutoInstance(providers, saved.driver, now);
  return choice ? { ...selection, instanceId: choice.account.instanceId } : selection;
}

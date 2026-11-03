/**
 * Fork: the account the daily sync's auto-fix chat runs on (imported with plain Node by
 * `fork/scripts/autofix-thread.mjs`): the first of `syncAutofixModelSelections` with an account
 * with usage left, on the account Auto would pick. With none left, the first model runs and fails.
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { chooseAutoInstance } from "@t3tools/shared/accountChoice";

export function autofixModelSelection(
  selections: ReadonlyArray<ModelSelection>,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): ModelSelection | null {
  for (const selection of selections) {
    const driver = providers.find(
      (provider) => provider.instanceId === selection.instanceId,
    )?.driver;
    const choice = driver ? chooseAutoInstance(providers, driver, now, selection.model) : null;
    if (choice) return { ...selection, instanceId: choice.account.instanceId };
  }
  return selections[0] ?? null;
}

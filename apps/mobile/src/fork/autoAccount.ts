/**
 * Fork (Owner): a new task on the phone runs on the account Auto would use,
 * as the desktop composer does: the default model moves to the instance of
 * its provider with the most usage left (`chooseAutoInstance`). Only the
 * default moves; a model picked by hand in the draft stays as picked.
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { chooseAutoInstance } from "@t3tools/shared/accountChoice";

export function withAutoAccount(
  selection: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
  // Re-read when the server's provider snapshots change, as the model options are.
  now: number = Date.now(),
): ModelSelection | null {
  if (!selection) return selection;
  const current = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (!current) return selection;
  const choice = chooseAutoInstance(providers, current.driver, now);
  const chosen = choice?.account;
  if (
    !chosen ||
    chosen.instanceId === selection.instanceId ||
    !chosen.models.some((model) => model.slug === selection.model)
  ) {
    return selection;
  }
  return { ...selection, instanceId: chosen.instanceId };
}

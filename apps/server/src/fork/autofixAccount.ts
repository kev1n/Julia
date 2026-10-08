/**
 * Fork (Owner): which account the daily sync's auto-fix chat runs on
 * (`fork/scripts/autofix-thread.mjs` imports this with plain Node). Claude Opus
 * on the Claude account Auto would pick; with every Claude account limited,
 * GPT-6.1 on the Codex account Auto would pick; with none usable either,
 * Claude owner (instance `claudeAgent`), which runs and fails as it would
 * have.
 */
import { ProviderInstanceId, type ModelSelection, type ServerProvider } from "@t3tools/contracts";
import { chooseAutoInstance } from "@t3tools/shared/accountChoice";

export function autofixModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): ModelSelection {
  const claude = chooseAutoInstance(providers, "claudeAgent", now);
  if (claude) return { instanceId: claude.account.instanceId, model: "claude-opus-5-5" };
  const codex = chooseAutoInstance(providers, "codex", now);
  if (codex) return { instanceId: codex.account.instanceId, model: "gpt-6.1-sol" };
  return { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
}

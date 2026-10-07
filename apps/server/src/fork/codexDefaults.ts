/**
 * Fork (Owner): Codex defaults to GPT-6.1-Sol at High reasoning. The model
 * goes first in the default preference (so the catalog marks it default) and
 * its High effort is marked default; every client picks both from the catalog.
 */
import { PREFERRED_DEFAULT_CODEX_MODELS } from "@t3tools/contracts";

const FORK_CODEX_MODEL = "gpt-6.1-sol";

export const FORK_PREFERRED_DEFAULT_CODEX_MODELS: ReadonlyArray<string> = [
  FORK_CODEX_MODEL,
  ...PREFERRED_DEFAULT_CODEX_MODELS.filter((slug) => slug !== FORK_CODEX_MODEL),
];

/** The default effort for a model family, or undefined to keep Codex's own. */
export function forkCodexDefaultEffort(family: string): string | undefined {
  return family === FORK_CODEX_MODEL ? "high" : undefined;
}

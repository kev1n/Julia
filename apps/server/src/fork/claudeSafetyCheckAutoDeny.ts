/**
 * Fork (Owner): Claude Code's dangerous-removal safety check asks even under bypass, and its own
 * TUI denies that ask when nobody answers in time. The SDK forwards the ask to canUseTool with no
 * such window (nor the check's kind), so a full-access T3 thread would wait on it forever.
 */
import * as NodeUtil from "node:util";

import type { RuntimeMode } from "@t3tools/contracts";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

// Claude Code's own default window (`timeoutMs: 120000` in its dangerous-removal check, CLI 2.1.302).
export const CLAUDE_SAFETY_CHECK_AUTO_DENY_MS = 120_000;

// Claude Code words every dangerous-removal reason `Dangerous ${command} operation ...`.
const DANGEROUS_REMOVAL_REASON = /^Dangerous \S+ operation\b/;

/** The deny message for an ask T3 should deny after the window, or undefined to wait for a person. */
export function claudeSafetyCheckAutoDenyMessage(input: {
  readonly runtimeMode: RuntimeMode;
  readonly callbackOptions: Pick<Parameters<CanUseTool>[2], "decisionReason" | "matchedAskRule">;
}): string | undefined {
  // An ask rule the user configured means they want a person to answer.
  if (input.runtimeMode !== "full-access" || input.callbackOptions.matchedAskRule !== undefined) {
    return undefined;
  }
  const reason = NodeUtil.stripVTControlCharacters(
    input.callbackOptions.decisionReason ?? "",
  ).trim();
  if (!DANGEROUS_REMOVAL_REASON.test(reason)) return undefined;
  return [
    `Permission for this command was denied automatically, not by the user: Claude Code's built-in safety check stopped it, and nobody answered the approval prompt within ${CLAUDE_SAFETY_CHECK_AUTO_DENY_MS / 60_000} minutes.`,
    "The command was NOT run; do not claim it succeeded.",
    "Rewrite the removal with a literal absolute path, or use `find <absolute dir> -mindepth 1 -delete`, which goes through the same check. Otherwise finish the rest of the task without it and tell the user what you wanted to delete and why.",
    `Safety check: ${reason}`,
  ].join(" ");
}

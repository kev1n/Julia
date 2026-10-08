/**
 * Fork (Owner): a provider added on one machine is added to every other paired
 * machine too, under the same instance ID, so accounts line up across machines.
 * Only the provider entry is copied; each machine keeps its own sign-in.
 */
import type { EnvironmentId } from "@t3tools/contracts";

export interface FanOutCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly canManageProviders: boolean;
  readonly instanceIds: ReadonlySet<string>;
}

export type FanOutSkipReason = "offline" | "no-permission" | "exists";

export interface FanOutPlan {
  readonly targets: ReadonlyArray<FanOutCandidate>;
  readonly skipped: ReadonlyArray<{ readonly label: string; readonly reason: FanOutSkipReason }>;
}

export function planProviderFanOut(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly instanceId: string;
  readonly candidates: ReadonlyArray<FanOutCandidate>;
}): FanOutPlan {
  const targets: Array<FanOutCandidate> = [];
  const skipped: Array<FanOutPlan["skipped"][number]> = [];
  for (const candidate of input.candidates) {
    if (candidate.environmentId === input.sourceEnvironmentId) continue;
    const reason: FanOutSkipReason | null = !candidate.connected
      ? "offline"
      : !candidate.canManageProviders
        ? "no-permission"
        : candidate.instanceIds.has(input.instanceId)
          ? "exists"
          : null;
    if (reason === null) targets.push(candidate);
    else skipped.push({ label: candidate.label, reason });
  }
  return { targets, skipped };
}

const SKIP_TEXT: Record<FanOutSkipReason, string> = {
  offline: "offline",
  "no-permission": "no permission",
  exists: "already has it",
};

/** One line for the result toast, e.g. "Also added to mac-a and MacBook. Skipped build-mac (offline)." */
export function describeFanOut(
  added: ReadonlyArray<string>,
  failed: ReadonlyArray<string>,
  skipped: FanOutPlan["skipped"],
  wording: { readonly done: string; readonly failed: string } = {
    done: "Also added to",
    failed: "Could not add to",
  },
): string {
  const parts: Array<string> = [];
  if (added.length > 0) parts.push(`${wording.done} ${joinLabels(added)}.`);
  if (failed.length > 0) parts.push(`${wording.failed} ${joinLabels(failed)}.`);
  if (skipped.length > 0) {
    parts.push(
      `Skipped ${joinLabels(skipped.map((entry) => `${entry.label} (${SKIP_TEXT[entry.reason]})`))}.`,
    );
  }
  return parts.join(" ");
}

function joinLabels(labels: ReadonlyArray<string>): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * Sets (or, with an empty value, removes) one sensitive variable in a provider
 * environment. Shared sign-ins, such as Claude's subscription token or a Cursor
 * API key, are saved this way on every machine.
 */
export function withProviderSecret<V extends { readonly name: string }>(
  environment: ReadonlyArray<V> | undefined,
  name: string,
  value: string,
): ReadonlyArray<V | { name: string; value: string; sensitive: true }> {
  const rest = (environment ?? []).filter((variable) => variable.name !== name);
  const trimmed = value.trim();
  return trimmed.length > 0 ? [...rest, { name, value: trimmed, sensitive: true }] : rest;
}

const ANSI_ESCAPE = new RegExp(
  String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*\u0007|[@-_])`,
  "g",
);

/** The token `claude setup-token` printed, if the terminal output holds one. */
export function readClaudeSetupToken(output: string): string | null {
  const tokens = output.replace(ANSI_ESCAPE, "").match(/sk-ant-oat01-[A-Za-z0-9_-]{20,}/g);
  return tokens?.at(-1) ?? null;
}

/** The sign-in page `claude auth login` printed, if the terminal output holds one. */
export function readClaudeLoginUrl(output: string): string | null {
  const urls = output.replace(ANSI_ESCAPE, "").match(/https:\/\/\S+\/oauth\/authorize\?\S+/g);
  return urls?.at(-1) ?? null;
}

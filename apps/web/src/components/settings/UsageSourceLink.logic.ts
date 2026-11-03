/**
 * Fork: which usage limit source a provider instance's requests appear to go through, from the
 * base URL in its setup. Only a suggestion for the link control: identity is the saved
 * `usageLimitSourceId`, never this match.
 */
import type {
  ProviderInstanceConfig,
  UnifiedSettings,
  UsageLimitSourceId,
} from "@t3tools/contracts";

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Claude reads `ANTHROPIC_BASE_URL`; Codex takes a `base_url` in its `-c` launch arguments. */
function instanceBaseUrl(instance: ProviderInstanceConfig): string | null {
  const fromEnvironment = instance.environment?.find(
    (variable) => variable.name === "ANTHROPIC_BASE_URL",
  )?.value;
  if (fromEnvironment) return fromEnvironment;
  const config = instance.config as { readonly launchArgs?: unknown } | undefined;
  const launchArgs = typeof config?.launchArgs === "string" ? config.launchArgs : "";
  return /base_url\s*=\s*\\?"([^"\\]+)/.exec(launchArgs)?.[1] ?? null;
}

export function suggestedUsageLimitSource(
  instance: ProviderInstanceConfig,
  sources: UnifiedSettings["usageLimitSources"],
): UsageLimitSourceId | null {
  const target = instanceBaseUrl(instance);
  const targetOrigin = target ? origin(target) : null;
  if (!targetOrigin) return null;
  const match = Object.entries(sources).find(
    ([, source]) => source.enabled && origin(source.url) === targetOrigin,
  );
  return match ? (match[0] as UsageLimitSourceId) : null;
}

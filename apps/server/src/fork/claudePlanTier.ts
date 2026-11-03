// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: the Max tier (5x, 20x) of a Claude subscription. The SDK says only `max`; the
 * rate-limit tier (e.g. `default_claude_max_20x`) is in `.claude.json` under CLAUDE_CONFIG_DIR or
 * home, a file without credentials. An unknown or missing tier leaves the plan as reported.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class ClaudeProfileReadError extends Schema.TaggedError<ClaudeProfileReadError>()(
  "ClaudeProfileReadError",
  { cause: Schema.Defect() },
) {}

const ClaudeProfile = Schema.fromJsonString(
  Schema.Struct({
    oauthAccount: Schema.optional(
      Schema.Struct({
        organizationRateLimitTier: Schema.optional(Schema.NullOr(Schema.String)),
        userRateLimitTier: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
const decodeClaudeProfile = Schema.decodeUnknownEffect(ClaudeProfile);

/** `default_claude_max_20x` → `20`; anything without an `<n>x` suffix → null. */
export function claudeTierMultiplier(rateLimitTier: unknown): string | null {
  if (typeof rateLimitTier !== "string") return null;
  return /_(\d+)x$/i.exec(rateLimitTier.trim())?.[1] ?? null;
}

/** A Max plan + tier `20` → `max20`, which the provider already labels "Max 20x". */
export function withClaudeTier(
  subscriptionType: string | undefined,
  multiplier: string | null,
): string | undefined {
  if (!subscriptionType || multiplier === null) return subscriptionType;
  // Claude reports Max as `max`, `Claude Max`, or `claude_max_subscription` depending on the path.
  const normalized = subscriptionType.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["max", "maxplan", "claudemax", "claudemaxsubscription"].includes(normalized)
    ? `max${multiplier}`
    : subscriptionType;
}

export const readClaudeTierMultiplier = (
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: () =>
      NodeFSP.readFile(
        NodePath.join(environment.CLAUDE_CONFIG_DIR?.trim() || NodeOS.homedir(), ".claude.json"),
        "utf8",
      ),
    catch: (cause) => new ClaudeProfileReadError({ cause }),
  }).pipe(
    Effect.flatMap(decodeClaudeProfile),
    Effect.map(
      ({ oauthAccount }) =>
        claudeTierMultiplier(oauthAccount?.organizationRateLimitTier) ??
        claudeTierMultiplier(oauthAccount?.userRateLimitTier),
    ),
    Effect.orElseSucceed(() => null),
  );

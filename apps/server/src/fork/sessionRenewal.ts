/**
 * Fork: a session issued for at least the paired-client lifetime renews while its client uses
 * it, so only a client idle for that whole lifetime has to pair again. Shorter sessions (DPoP
 * tokens renewed through T3 Connect, CLI tokens issued with `--ttl`) keep their fixed deadline.
 */
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

export function renewedSessionExpiry(
  session: { readonly issuedAt: DateTime.DateTime; readonly expiresAt: DateTime.DateTime },
  now: DateTime.Utc,
  lifetime: Duration.Duration,
): Option.Option<DateTime.Utc> {
  const lifetimeMs = Duration.toMillis(lifetime);
  const renewable =
    session.expiresAt.epochMilliseconds - session.issuedAt.epochMilliseconds >= lifetimeMs;
  if (!renewable) return Option.none();
  const renewed = DateTime.add(now, { milliseconds: lifetimeMs });
  return renewed.epochMilliseconds > session.expiresAt.epochMilliseconds
    ? Option.some(renewed)
    : Option.none();
}

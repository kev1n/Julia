/**
 * Fork (Owner): intent-based coordination suggestions. Clients never message
 * either thread automatically.
 */
import * as Schema from "effect/Schema";

export const ForkFleetOverlapsInput = Schema.Struct({ threadId: Schema.String });
export type ForkFleetOverlapsInput = typeof ForkFleetOverlapsInput.Type;

export const ForkFleetOverlap = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  machine: Schema.String,
  lifecycle: Schema.Literals(["running", "idle"]),
  branch: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["conflicting_intent", "duplicate_investigation"]),
  /** Concrete reason these chats may benefit from communicating. */
  reason: Schema.String,
  /** The owning server's URL, usable even when the peer is not connected in this client. */
  url: Schema.String,
});
export type ForkFleetOverlap = typeof ForkFleetOverlap.Type;

export const ForkFleetOverlapsResult = Schema.Struct({
  overlaps: Schema.Array(ForkFleetOverlap),
  status: Schema.Literals(["ready", "checking", "unavailable"]),
  /** Some relevant chats could not be evaluated (offline, old server, or input cap). */
  partial: Schema.optional(Schema.Boolean),
});
export type ForkFleetOverlapsResult = typeof ForkFleetOverlapsResult.Type;

/**
 * Fork (Owner): where a thread's history is. A settled or archived thread's
 * history moves to Azure Blob Storage and is kept there 60 days from settling;
 * opening the thread brings it back. Subscribing to `fork.threadHistory` for a
 * thread whose history is away starts that restore, then reports each change.
 */
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

export const ForkThreadHistoryInput = Schema.Struct({ threadId: ThreadId });
export type ForkThreadHistoryInput = typeof ForkThreadHistoryInput.Type;

export const ForkThreadHistoryStatus = Schema.Struct({
  /**
   * `local`: on this machine. `restoring`: coming back from Azure now.
   * `expired`: deleted from Azure 60 days after the thread settled.
   * `unavailable`: Azure could not be reached; subscribing again retries.
   */
  state: Schema.Literals(["local", "restoring", "expired", "unavailable"]),
  /** When the history left this machine. */
  offloadedAt: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type ForkThreadHistoryStatus = typeof ForkThreadHistoryStatus.Type;

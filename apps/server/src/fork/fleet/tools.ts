/**
 * Fork: the fleet toolkit. What other agents on the fleet's machines are
 * doing, and a way to read or message their threads. Every answer carries
 * `asOf` and per-environment `coverage`, so "no matches" never hides an
 * offline machine.
 */
import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { FleetCoverage, FleetIntent, FleetLifecycle } from "./model.ts";

const Envelope = {
  asOf: Schema.String,
  hub: Schema.Literals(["reachable", "unreachable", "not-configured"]),
  coverage: Schema.Array(FleetCoverage),
};

const ThreadSummary = Schema.Struct({
  environmentId: Schema.String,
  machine: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  lifecycle: FleetLifecycle,
  repo: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  checkout: Schema.NullOr(Schema.String),
  /** Paths changed in the checkout (committed vs base, staged, unstaged, untracked). */
  changedPaths: Schema.Number,
  intents: Schema.Array(FleetIntent),
  lastActivityAt: Schema.NullOr(Schema.String),
  /** The machine has missed heartbeats; this record may be out of date. */
  stale: Schema.Boolean,
});

const Evidence = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("observed"),
    kind: Schema.Literals(["committed", "staged", "unstaged", "untracked"]),
    change: Schema.String,
  }),
  Schema.Struct({
    source: Schema.Literal("declared"),
    key: Schema.String,
    access: Schema.Literals(["read", "write"]),
  }),
]);

const Overlap = Schema.Struct({
  thread: ThreadSummary,
  sharedCheckout: Schema.Boolean,
  paths: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      conflict: Schema.Literals(["write/write", "read/write", "read/read"]),
      mine: Schema.Array(Evidence),
      theirs: Schema.Array(Evidence),
      sku: Schema.optional(Schema.String),
      provider: Schema.optional(Schema.String),
    }),
  ),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
  ServerEnvironment.ServerEnvironment,
];
const shared = { failure: OrchestratorMcpFailure, failureMode: "return" as const, dependencies };

const FleetListTool = Tool.make("t3_fleet_list", {
  ...shared,
  description:
    "List T3 threads on every machine in your fleet (labels in coverage) with lifecycle (running, idle, settled, archived), repository, branch, how many paths their checkout has changed, and declared work. Settled and archived threads are omitted unless includeInactive=true. coverage says which machines answered and how fresh their data is.",
  parameters: Schema.Struct({
    includeInactive: Schema.optional(Schema.Boolean),
    repo: Schema.optional(
      Schema.String.annotate({
        description: "Only this repository key; 'current' for the calling thread's repository.",
      }),
    ),
  }),
  success: Schema.Struct({ ...Envelope, threads: Schema.Array(ThreadSummary) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const WhoElseTool = Tool.make("t3_who_else", {
  ...shared,
  description:
    "Which other active threads, on any machine in your fleet, touch the same files as this thread: paths changed in their checkout (committed, staged, unstaged, untracked) or declared with t3_work_publish. Rescans this thread's checkout first. Optional paths (repository-relative; a trailing / covers a directory) are checked as well. Each overlap says whose evidence is observed or declared, and write/write vs read/write. Nothing tells you about overlaps on its own: call this before editing shared code and before committing. On a write/write overlap, read that thread with t3_fleet_thread_read and decide whether to coordinate with t3_fleet_thread_send.",
  parameters: Schema.Struct({ paths: Schema.optional(Schema.Array(Schema.String)) }),
  success: Schema.Struct({
    ...Envelope,
    me: Schema.NullOr(ThreadSummary),
    overlaps: Schema.Array(Overlap),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const WorkPublishTool = Tool.make("t3_work_publish", {
  ...shared,
  description:
    "Declare what this thread is about to read or write, so other agents see it before your edits exist. Replaces this thread's previous declaration (an empty list clears it). Keys are repository-relative paths; a trailing / covers a directory. Returns the current overlaps with other active threads in the same call.",
  parameters: Schema.Struct({ intents: Schema.Array(FleetIntent) }),
  success: Schema.Struct({
    ...Envelope,
    published: Schema.Number,
    me: Schema.NullOr(ThreadSummary),
    overlaps: Schema.Array(Overlap),
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const FleetThreadReadTool = Tool.make("t3_fleet_thread_read", {
  ...shared,
  description:
    "Read a thread on any machine in your fleet, fetched from the machine that owns it. Same paging as t3_thread_read: continue with afterPosition=nextPosition; recover long items with itemId and textOffset.",
  parameters: Schema.Struct({
    ...OrchestratorMcpThreadReadInput.fields,
    environmentId: Schema.String,
  }),
  success: Schema.Struct({
    ...Envelope,
    environmentId: Schema.String,
    result: OrchestratorMcpThreadReadResult,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const FleetThreadSendTool = Tool.make("t3_fleet_thread_send", {
  ...shared,
  description:
    "Send a message to a thread on any machine in your fleet about that thread's own work. It is not for handing a new task to another machine, and the sender gets no notice when the thread finishes; for a new task there, use delegate_task with machine. The owning machine checks that the target runs within this thread's permission modes. mode: auto (start if idle, steer an active turn, else queue), queue, or steer; restart is not offered across machines. idempotencyKey is required: retrying with the same key delivers at most once. If the outcome is 'unknown' (timeout or lost answer), it was not retried for you; retry with the same idempotencyKey.",
  parameters: Schema.Struct({
    environmentId: Schema.String,
    threadId: Schema.String,
    message: Schema.String,
    mode: Schema.optional(Schema.Literals(["auto", "queue", "steer"])),
    idempotencyKey: Schema.String,
  }),
  success: Schema.Struct({
    ...Envelope,
    outcome: Schema.Literals(["delivered", "unknown"]),
    result: Schema.NullOr(OrchestratorMcpThreadSendResult),
    note: Schema.optional(Schema.String),
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const FleetToolkit = Toolkit.make(
  FleetListTool,
  WhoElseTool,
  WorkPublishTool,
  FleetThreadReadTool,
  FleetThreadSendTool,
);

export type FleetThreadSummary = typeof ThreadSummary.Type;
export type FleetOverlapOut = typeof Overlap.Type;

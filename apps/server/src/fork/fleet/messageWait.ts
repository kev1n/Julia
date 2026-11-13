/**
 * Fork: t3_thread_wait on the machine that owns the thread, plus waiting by a
 * sent message and returning the run's reply. Shared by t3_fleet_thread_wait's
 * local path and the peer/wait route.
 */
import {
  MessageId,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  type ThreadId,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import type * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "./config.ts";

export const FleetWaitInput = Schema.Struct({
  ...OrchestratorMcpThreadWaitInput.fields,
  messageId: Schema.optional(
    MessageId.annotate({
      description: "From t3_fleet_thread_send: wait for the run holding this message.",
    }),
  ),
});
export type FleetWaitInput = typeof FleetWaitInput.Type;

export const FleetWaitResult = Schema.Struct({
  ...OrchestratorMcpThreadWaitResult.fields,
  /** Once the run ends: its last assistant message or the error it failed on; null if none. */
  output: Schema.optional(Schema.NullOr(Schema.String)),
});
export type FleetWaitResult = typeof FleetWaitResult.Type;

const fail = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

export const waitOnThisMachine = Effect.fn("fleet.waitOnThisMachine")(function* (
  service: OrchestratorMcpService.OrchestratorMcpService["Service"],
  threads: ThreadManagementService.ThreadManagementService["Service"],
  scope: McpInvocationScope,
  { messageId, ...input }: FleetWaitInput,
) {
  const unavailable = () => fail("orchestration_error", "Thread state is unavailable.");
  const messageRun = (threadId: ThreadId, id: MessageId) =>
    threads.getThreadRecords(threadId, ["messages"], { messageIds: [id] }).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(({ messages }) => {
        const runId = messages.find((message) => message.id === id)?.runId;
        return runId == null
          ? Effect.fail(fail("run_not_found", `Message ${id} has no run on thread ${threadId}.`))
          : Effect.succeed(runId);
      }),
    );

  let result: OrchestratorMcpThreadWaitResult;
  if (messageId === undefined) {
    result = yield* service.waitForThread(scope, input);
  } else {
    if (input.runId !== undefined) {
      return yield* fail("invalid_request", "Pass runId or messageId, not both.");
    }
    const deadline =
      (yield* Clock.currentTimeMillis) +
      Math.min(MAX_WAIT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_MS));
    while (true) {
      const runId = yield* messageRun(input.threadId, messageId);
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      result = yield* service.waitForThread(scope, {
        ...input,
        runId,
        timeoutMs: Math.max(1, remaining),
      });
      // Promoting a queued message to steer cancels its run and moves the
      // message onto the active one; follow it there.
      if (result.timedOut || (yield* messageRun(input.threadId, messageId)) === runId) break;
    }
  }
  if (result.timedOut || result.runId === null) return result satisfies FleetWaitResult;

  const resultRunId = result.resultRun?.runId ?? result.runId;
  const records = yield* threads
    .getThreadRecords(input.threadId, ["runs", "messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [resultRunId],
      turnItemRunIds: [resultRunId],
      turnItemTypes: ["assistant_message", "error"],
    })
    .pipe(Effect.mapError(unavailable));
  const run = records.runs.find((candidate) => candidate.id === resultRunId);
  if (run === undefined) return { ...result, output: null } satisfies FleetWaitResult;
  const reply = subagentResultForRun({ ...records, providerTurns: [] }, run);
  const found = reply.messageId !== null || reply.turnItemId !== null;
  return { ...result, output: found ? reply.text : null } satisfies FleetWaitResult;
});

import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { waitOnThisMachine } from "./messageWait.ts";

it.effect("waits for a sent message's run, following it when a queued message is promoted", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-target");
    const messageId = MessageId.make("message-sent");
    const queuedRunId = RunId.make("run-queued");
    const activeRunId = RunId.make("run-active");
    const at = DateTime.makeUnsafe(0);
    const state = { messageRunId: queuedRunId };
    const waitedRuns: Array<RunId | undefined> = [];

    const service = {
      waitForThread: (_scope, input) => {
        waitedRuns.push(input.runId);
        // Promotion to steer cancels the queued run and moves the message in one commit.
        if (input.runId === queuedRunId) state.messageRunId = activeRunId;
        return Effect.succeed({
          threadId,
          runId: input.runId ?? null,
          status: input.runId === queuedRunId ? "cancelled" : "completed",
          timedOut: false,
        });
      },
    } as Partial<OrchestratorMcpService.OrchestratorMcpService["Service"]>;
    const threads = {
      getThreadRecords: (_threadId: ThreadId, fields: ReadonlyArray<string>) =>
        Effect.succeed(
          fields.includes("runs")
            ? {
                runs: [
                  { id: queuedRunId, status: "cancelled" },
                  { id: activeRunId, status: "completed", modelSelection: { model: "m" } },
                ],
                messages: [
                  {
                    id: "reply",
                    runId: activeRunId,
                    role: "assistant",
                    text: "Done: the parser is fixed.",
                    createdAt: at,
                    updatedAt: at,
                  },
                ],
                turnItems: [],
              }
            : { messages: [{ id: messageId, runId: state.messageRunId }] },
        ),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];

    const result = yield* waitOnThisMachine(
      service as OrchestratorMcpService.OrchestratorMcpService["Service"],
      threads,
      {} as never,
      { threadId, messageId, timeoutMs: 60_000 },
    );

    expect(waitedRuns).toEqual([queuedRunId, activeRunId]);
    expect(result).toMatchObject({
      runId: activeRunId,
      status: "completed",
      timedOut: false,
      output: "Done: the parser is fixed.",
    });
  }),
);

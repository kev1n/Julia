import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import { restartWakeSourceRun } from "./restartWake.ts";

type Projection = Parameters<typeof restartWakeSourceRun>[0];

/** A thread whose turn completed while a Claude subagent it started kept running. */
function projection(overrides: {
  readonly sessionStatus?: string;
  readonly runStatus?: string;
  readonly archived?: boolean;
  readonly item?: Record<string, unknown> | null;
  readonly roster?: ReadonlyArray<unknown>;
}): Projection {
  return {
    thread: {
      id: "thread",
      providerInstanceId: "claude",
      archivedAt: overrides.archived === true ? "2026-10-14T00:00:00.000Z" : null,
      deletedAt: null,
    },
    runs: [
      {
        id: "run",
        ordinal: 1,
        status: overrides.runStatus ?? "completed",
        providerThreadId: "provider-thread",
        providerInstanceId: "claude",
      },
    ],
    providerThreads: [
      {
        id: "provider-thread",
        appThreadId: "thread",
        ownerNodeId: null,
        providerSessionId: "session",
        pendingBackgroundTasks: overrides.roster ?? [],
      },
    ],
    providerSessions: [{ id: "session", status: overrides.sessionStatus ?? "ready" }],
    turnItems:
      overrides.item === null
        ? []
        : [
            {
              type: "subagent",
              status: "running",
              origin: "provider_native",
              childThreadId: null,
              providerThreadId: "provider-thread",
              runId: "run",
              ...overrides.item,
            },
          ],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("wakes a settled turn whose background work is live", () => {
  assert.equal(restartWakeSourceRun(projection({}))?.id, "run");
  // Stopped with "stop only the main agent": its subagents were kept on purpose.
  assert.equal(restartWakeSourceRun(projection({ runStatus: "interrupted" }))?.id, "run");
  const monitor = { taskId: "b1", kind: "monitor" };
  assert.equal(restartWakeSourceRun(projection({ item: null, roster: [monitor] }))?.id, "run");
});

it("does not wake for stale rows, put-away threads, or work upstream already continues", () => {
  // Rows still "running" under a stopped session are not running anything.
  assert.isUndefined(restartWakeSourceRun(projection({ sessionStatus: "stopped" })));
  assert.isUndefined(restartWakeSourceRun(projection({ archived: true })));
  // A delegate_task child is its own thread and reports back itself.
  assert.isUndefined(
    restartWakeSourceRun(projection({ item: { origin: "app_owned", childThreadId: "child" } })),
  );
  assert.isUndefined(restartWakeSourceRun(projection({ item: { status: "completed" } })));
  assert.isUndefined(restartWakeSourceRun(projection({ runStatus: "running" })));
  assert.isUndefined(restartWakeSourceRun(projection({ runStatus: "failed" })));
});

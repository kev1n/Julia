import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  subagentThreadListExpiry,
  subagentThreadListStatus,
  visibleSubagentThreadList,
} from "./subagentThreadList.ts";

const finishedAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const finishedMs = DateTime.toEpochMillis(finishedAt);
const environmentId = EnvironmentId.make("env");
const parentId = ThreadId.make("parent");
const finished = presentThreadShell(environmentId, {
  ...v2ThreadShell,
  id: ThreadId.make("child"),
  lineage: { parentThreadId: parentId, rootThreadId: parentId, relationshipToParent: "subagent" },
  latestRunId: RunId.make("child-run"),
  status: "completed",
  latestRunCompletedAt: finishedAt,
});

describe("sidebar subagent lifetime", () => {
  it("expires at two minutes without changing the durable child or its history", () => {
    const children = [finished];
    expect(visibleSubagentThreadList(children, finishedMs + 119_999)).toEqual({
      threads: children,
      nextExpiry: finishedMs + 120_000,
    });
    expect(visibleSubagentThreadList(children, finishedMs + 120_000)).toEqual({
      threads: [],
      nextExpiry: null,
    });
    expect(children).toEqual([finished]);
    expect(finished.latestRun?.status).toBe("completed");
  });

  it("uses completion time rather than later title or visit updates", () => {
    expect(subagentThreadListExpiry({ ...finished, updatedAt: "2026-06-20T00:05:00.000Z" })).toBe(
      finishedMs + 120_000,
    );
  });

  it.each(["failed", "cancelled", "interrupted", "rolled_back"] as const)(
    "also expires finished %s agents, with an update-time fallback for old summaries",
    (status) => {
      const child = presentThreadShell(environmentId, {
        ...finished.source,
        status,
        latestRunCompletedAt: null,
      });
      expect(subagentThreadListExpiry(child)).toBe(finishedMs + 120_000);
    },
  );

  it("keeps agents that resumed, are waiting on input, or have delegated work", () => {
    const resumed = presentThreadShell(environmentId, {
      ...finished.source,
      status: "running",
      latestRunCompletedAt: null,
    });
    const waiting = { ...finished, hasPendingUserInput: true };
    const approval = { ...finished, hasPendingApprovals: true };
    const delegating = {
      ...finished,
      pendingBackgroundTasks: [{ taskId: "nested", kind: "subagent" as const }],
    };
    expect(
      visibleSubagentThreadList([resumed, waiting, approval, delegating], finishedMs + 600_000)
        .threads,
    ).toEqual([resumed, waiting, approval, delegating]);
  });

  it("arms only the earliest remaining deadline in a mixed roster", () => {
    const second = presentThreadShell(environmentId, {
      ...finished.source,
      id: ThreadId.make("second"),
      latestRunCompletedAt: DateTime.makeUnsafe(finishedMs + 30_000),
    });
    expect(visibleSubagentThreadList([finished, second], finishedMs + 120_001)).toEqual({
      threads: [second],
      nextExpiry: finishedMs + 150_000,
    });
  });
});

it("tracks a runless native subagent through completion and resumption", () => {
  const child = presentThreadShell(environmentId, {
    ...finished.source,
    creationSource: "provider",
    latestRunId: null,
    status: "idle",
    nativeSubagentActivity: { status: "running", completedAt: null },
  });
  expect(child.runtime).toBeNull();
  expect(subagentThreadListStatus(child)).toBe("In progress");
  expect(subagentThreadListExpiry(child)).toBeNull();
  const completed = {
    ...child,
    source: {
      ...child.source,
      nativeSubagentActivity: {
        status: "completed" as const,
        completedAt: DateTime.formatIso(finishedAt),
      },
    },
  };
  expect(subagentThreadListStatus(completed)).toBe("Completed");
  expect(visibleSubagentThreadList([completed], finishedMs + 120_000).threads).toEqual([]);
  expect(visibleSubagentThreadList([child], finishedMs + 600_000).threads).toEqual([child]);
});

import { it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, vi } from "vite-plus/test";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import type { FleetConfig } from "./config.ts";
import type { FleetIndex, FleetSnapshot } from "./model.ts";
import { fleetMachines, readFleetThread } from "./unlinked.ts";

const snapshot = (environmentId: string, label: string): FleetSnapshot => ({
  environmentId,
  label,
  baseUrl: `https://${environmentId}.test`,
  incarnation: "incarnation",
  seq: 1,
  complete: true,
  lastScanAt: null,
  threads: [],
  checkouts: [],
});

const config: FleetConfig = {
  hubUrl: "https://hub.test",
  selfUrl: "https://mini.test",
  secret: "secret",
  hub: false,
  userdataDir: "/nowhere",
  pathMeanings: [],
  mirrorProjects: true,
};
const mini = snapshot("mini", "Mac mini");
const index: FleetIndex = {
  asOf: 1,
  staleAfterMs: 30_000,
  environments: [
    { snapshot: mini, receivedAt: 1 },
    { snapshot: snapshot("laptop", "Laptop"), receivedAt: 1 },
  ],
};

const laptopThread = ThreadId.make("thread:on-laptop");
const laptopRead = {
  thread: {
    threadId: laptopThread,
    projectId: "project:laptop",
    title: "On the laptop",
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    latestRunId: null,
    activeRunId: null,
    providerInstanceId: "codex",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 0,
    itemCount: 0,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  recentRuns: [],
  items: [],
  nextPosition: null,
  hasMore: false,
};

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("mini"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: "provider-session:caller",
  thread: undefined,
  client: undefined,
};
const caller = liveThreadShell(ThreadId.make("thread:caller"), { runtimeMode: "auto" });

/** The hub's index, and the laptop answering `peer/read`; every peer request is kept. */
const serveFleet = (peerRequests: Array<{ readonly url: string; readonly body: unknown }>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "https://hub.test/fork/fleet/hub/index") return Response.json(index);
    peerRequests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: laptopRead });
  });

it.effect("reads a thread from the fleet machine that owns it, as the calling thread", () =>
  Effect.gen(function* () {
    const peerRequests: Array<{ readonly url: string; readonly body: unknown }> = [];
    using _fetch = serveFleet(peerRequests);
    const read = (environmentId: string) =>
      readFleetThread({
        config,
        local: mini,
        scope,
        caller,
        environmentId,
        read: {
          environmentId: EnvironmentId.make(environmentId),
          threadId: laptopThread,
          view: "activity",
        },
      });

    // A machine the fleet does not list is left to a link.
    expect(Option.isNone(yield* read("elsewhere"))).toBe(true);
    expect(peerRequests).toEqual([]);

    expect(Option.getOrThrow(yield* read("laptop")).thread.title).toBe("On the laptop");
    // The owner holds the read to the caller's mode, and is not told which machine was named.
    expect(peerRequests).toEqual([
      {
        url: "https://laptop.test/fork/fleet/peer/read",
        body: {
          source: {
            environmentId: "mini",
            label: "Mac mini",
            threadId: "thread:caller",
            title: "thread:caller",
            runtimeMode: "auto",
          },
          input: { threadId: laptopThread, view: "activity" },
        },
      },
    ]);

    expect(yield* fleetMachines(config, mini)).toEqual([
      { environmentId: "laptop", label: "Laptop" },
    ]);
    expect(yield* fleetMachines(null, mini)).toEqual([]);
  }),
);

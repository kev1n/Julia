import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import type {
  OrchestrationProjectShell,
  OrchestratorMcpCapabilitiesResult,
  OrchestrationV2ThreadShell,
  OrchestratorMcpThreadSendInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import type { FleetSnapshot } from "./model.ts";
import { makePeerHandlers, remoteChildrenToSettle } from "./remoteTasks.ts";

const REPO = "github.com/example/t3code";
const source = {
  environmentId: "env-laptop",
  label: "laptop",
  threadId: "parent-thread",
  title: "Parent",
  runtimeMode: "full-access",
} as const;
const parentModelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

/** The child machine (office): one unrelated project, one checkout of REPO. */
function machine(runs: ReadonlyArray<{ id: string; ordinal: number; status: string }>) {
  const launches: ThreadLaunch.ThreadLaunchInput[] = [];
  const sends: { scope: McpInvocationScope; input: OrchestratorMcpThreadSendInput }[] = [];
  const at = DateTime.makeUnsafe(0);
  const layer = Layer.mergeAll(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({ environmentId: "env-office", label: "office" } as never),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      capabilities: () =>
        Effect.succeed({
          providers: [
            { providerInstanceId: "claudeAgent", models: [{ id: "claude-opus-5-5" }] },
            { providerInstanceId: "codex", driverKind: "codex", models: [{ id: "gpt-6" }] },
          ],
        } as unknown as OrchestratorMcpCapabilitiesResult),
      sendToThread: (scope, input) => {
        sends.push({ scope, input });
        return Effect.succeed({} as never);
      },
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          id: threadId,
          title: "Review the parser",
          deletedAt: null,
          archivedAt: null,
          settledOverride: "settled",
          settledAt: at,
          activeRunId: null,
          lineage: { parentThreadId: "p", relationshipToParent: "subagent", rootThreadId: "p" },
          runtimeMode: "approval-required",
          modelSelection: parentModelSelection,
        } as never),
      getThreadRecords: () =>
        Effect.succeed({
          runs,
          messages: [
            { runId: "run-1", role: "assistant", text: "Found two bugs.", updatedAt: at, id: "m" },
          ],
          turnItems: [],
          providerTurns: [],
          runtimeRequests: [],
        } as never),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        launches.push(input);
        return Effect.succeed({ projection: { thread: { id: "child-thread" } } } as never);
      },
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () =>
        Effect.succeed([
          { id: "other", workspaceRoot: "/src/other", repositoryIdentity: { canonicalKey: "x" } },
          { id: "t3code", workspaceRoot: "/src/t3code", repositoryIdentity: null },
        ] as unknown as ReadonlyArray<OrchestrationProjectShell>),
    }),
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: (cwd) =>
        Effect.succeed(cwd === "/src/t3code" ? ({ canonicalKey: REPO } as never) : null),
    }),
  );
  return { launches, sends, layer };
}

const delegation = (key: string, target?: unknown) => ({
  source,
  key,
  repoKey: REPO,
  baseRef: "main",
  title: "Review the parser",
  task: "Review the parser.",
  ...(target === undefined ? {} : { target }),
  parentModelSelection,
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
});

describe("delegated tasks on another machine", () => {
  it.effect("start in a fresh worktree of the parent's repository with the parent's model", () => {
    const child = machine([{ id: "run-1", ordinal: 1, status: "running" }]);
    return Effect.gen(function* () {
      const handlers = yield* makePeerHandlers;
      const delegate = handlers.get("peer/delegate")!;
      const result = (yield* delegate(delegation("round-1"))) as Record<string, unknown>;
      yield* delegate(delegation("round-1"));
      yield* delegate(delegation("round-2"));

      expect(result).toMatchObject({
        taskId: "fleet:env-office:child-thread",
        status: "running",
        machine: "office",
        summary: null,
      });
      const [first, retry, second] = child.launches;
      expect(first).toMatchObject({
        projectId: "t3code",
        modelSelection: parentModelSelection,
        runtimeMode: "auto-accept-edits",
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
        // A subagent of the parent thread on the laptop, not a top-level thread.
        remoteParentThreadId: "parent-thread",
      });
      // A retried request replays the same launch; a new round is a new one.
      expect(retry!.commandId).toBe(first!.commandId);
      expect(second!.commandId).not.toBe(first!.commandId);
    }).pipe(Effect.provide(child.layer));
  });

  it.effect("refuse a model this machine does not offer and modes above the parent's", () => {
    const child = machine([]);
    return Effect.gen(function* () {
      const delegate = (yield* makePeerHandlers).get("peer/delegate")!;
      const refusal = (body: unknown) =>
        delegate(body).pipe(
          Effect.match({ onFailure: (error) => error.code, onSuccess: () => "started" }),
        );
      expect(yield* refusal(delegation("a", { providerInstanceId: "codex", model: "gpt-1" }))).toBe(
        "model_unavailable",
      );
      expect(
        yield* refusal({
          ...delegation("b"),
          source: { ...source, runtimeMode: "approval-required" },
        }),
      ).toBe("runtime_mode_escalation_denied");
      expect(child.launches).toHaveLength(0);
    }).pipe(Effect.provide(child.layer));
  });

  it.effect("list this machine's providers for a caller elsewhere", () => {
    const child = machine([]);
    return Effect.gen(function* () {
      const list = (yield* makePeerHandlers).get("peer/providers")!;
      const providers = (yield* list({ source })) as ReadonlyArray<{ providerInstanceId: string }>;
      expect(providers.map((provider) => provider.providerInstanceId)).toEqual([
        "claudeAgent",
        "codex",
      ]);
    }).pipe(Effect.provide(child.layer));
  });

  it.effect("report the first run's final message once it ends", () => {
    const child = machine([
      { id: "run-1", ordinal: 1, status: "completed" },
      { id: "run-2", ordinal: 2, status: "running" },
    ]);
    return Effect.gen(function* () {
      const read = (yield* makePeerHandlers).get("peer/task")!;
      const result = yield* read({ source, threadId: "child-thread" as ThreadId });
      expect(result).toMatchObject({
        status: "completed",
        workState: "result_available",
        summary: "Found two bugs.",
        hasPendingChildRuns: true,
      });
    }).pipe(Effect.provide(child.layer));
  });

  it.effect("wake the parent thread with a result, within the parent's own modes", () => {
    const parent = machine([]);
    return Effect.gen(function* () {
      const deliver = (yield* makePeerHandlers).get("peer/task-result")!;
      yield* deliver({
        machine: "office",
        parentThreadId: "parent-thread",
        taskId: "fleet:env-office:child-thread",
        title: "Review the parser",
        link: "[Review the parser](t3://thread/env-office/child-thread)",
        status: "completed",
        summary: "Found two bugs.",
        key: "fleet-task-result:env-office:child-thread:run-1",
      });
      const [send] = parent.sends;
      expect(send!.scope.client?.access).toBe("approval-required");
      expect(send!.input).toMatchObject({
        threadId: "parent-thread",
        mode: "auto",
        clientRequestId: "fleet-task-result:env-office:child-thread:run-1",
      });
      expect(send!.input.message).toContain("Remote task on office completed");
      expect(send!.input.message).toContain("Found two bugs.");
    }).pipe(Effect.provide(parent.layer));
  });
});

describe("remote subagents follow their parent", () => {
  const child = (id: string, parentThreadId: string, changes: object = {}) =>
    ({
      id,
      lineage: { parentThreadId, relationshipToParent: "subagent", rootThreadId: id },
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      activeRunId: null,
      ...changes,
    }) as unknown as OrchestrationV2ThreadShell;
  const laptop = { environmentId: "env-laptop", label: "laptop" } as FleetSnapshot;
  const studio = { environmentId: "env-studio", label: "studio" } as FleetSnapshot;

  it.effect("settle an idle child once its parent's own machine says it is settled", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const settled = yield* remoteChildrenToSettle(
        [
          child("of-settled", "settled-parent"),
          child("of-archived", "archived-subagent-parent"),
          child("of-idle", "idle-parent"),
          child("still-running", "settled-parent", { activeRunId: "run-1" }),
          child("already-settled", "settled-parent", { settledOverride: "settled" }),
          // Its parent's machine does not answer: nothing is assumed from older state.
          child("of-unreachable", "parent-on-studio"),
          // A local subagent follows its local parent, never another machine's thread.
          child("local-parent", "x", { lineage: { relationshipToParent: null } }),
          child("of-local", "local-parent"),
        ],
        [laptop, studio],
        (machine, parentIds) => {
          asked.push(`${machine.label}:${parentIds.join(",")}`);
          return machine === studio
            ? Effect.succeed(null)
            : Effect.succeed({
                "settled-parent": "settled",
                "archived-subagent-parent": "archived",
                "idle-parent": "idle",
              } as const);
        },
      );
      expect(settled).toEqual(["of-settled", "of-archived"]);
      expect(asked).toContain(
        "laptop:settled-parent,archived-subagent-parent,idle-parent,parent-on-studio",
      );
    }),
  );

  it.effect("answer a parent's lifecycle from this machine's own threads, subagents too", () => {
    const parent = machine([]);
    return Effect.gen(function* () {
      const handlers = yield* makePeerHandlers;
      const answer = yield* handlers.get("peer/thread-lifecycles")!({
        threadIds: ["subagent-parent"],
      });
      expect(answer).toEqual({ "subagent-parent": "settled" });
    }).pipe(Effect.provide(parent.layer));
  });
});

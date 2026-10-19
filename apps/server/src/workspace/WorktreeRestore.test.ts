import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorktreeRestore from "./WorktreeRestore.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";

const threadId = ThreadId.make("thread:worktree-restore");
const projectId = ProjectId.make("project:worktree-restore");

// Git and the setup script are stand-ins unless real terminals are given; the
// worktree, its .git file and the pending-setup marker are real files in a temp folder.
const harness = Effect.fn(function* (
  exitCodes: Array<number>,
  terminals?: TerminalManager.TerminalManager["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-restore-" });
  const worktreePath = path.join(root, "worktrees", "feature");
  const adminDir = path.join(root, "repo", ".git", "worktrees", "feature");
  const calls = { prune: 0, create: 0, setup: 0 };
  const setupStarted = yield* Deferred.make<void>();
  const setupGate = yield* Deferred.make<void>();
  yield* Deferred.succeed(setupGate, undefined);
  let gate = setupGate;
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () =>
      Effect.succeedSome({
        id: projectId,
        workspaceRoot: path.join(root, "repo"),
        scripts: [
          {
            id: "setup",
            name: "Setup Worktree",
            command: "vp i",
            icon: "configure",
            runOnWorktreeCreate: true,
            async: false,
          },
        ],
      } as never),
  });
  const restore = yield* WorktreeRestore.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.sync(() => void calls.prune++),
          listLocalBranchNames: () => Effect.succeed(["feature"]),
          createWorktree: () =>
            Effect.gen(function* () {
              calls.create++;
              yield* fs.makeDirectory(worktreePath, { recursive: true });
              yield* fs.makeDirectory(adminDir, { recursive: true });
              yield* fs.writeFileString(path.join(worktreePath, ".git"), `gitdir: ${adminDir}\n`);
              return {} as never;
            }).pipe(Effect.orDie),
        }),
        projects,
        terminals !== undefined
          ? Layer.succeedContext(
              // Built in the test's scope: the runner writes the command from a fiber in it.
              yield* Layer.build(
                ProjectSetupScriptRunner.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      projects,
                      Layer.succeed(TerminalManager.TerminalManager, terminals),
                      // No linked-environment thread here, so setup is never skipped.
                      Layer.mock(ProjectionStore.ProjectionStoreV2)({
                        getThreadShell: () => Effect.succeed(null),
                      }),
                      ServerSettings.layerTest(),
                      NodeCrypto.layer,
                    ),
                  ),
                ),
              ),
            )
          : Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
              runForThread: () =>
                Effect.sync(() => {
                  Deferred.doneUnsafe(setupStarted, Effect.void);
                  const exitCode = exitCodes[calls.setup++] ?? 0;
                  return {
                    status: "started",
                    scriptId: "setup",
                    scriptName: "Setup Worktree",
                    scriptCommand: "vp i",
                    terminalId: "setup-setup",
                    cwd: worktreePath,
                    async: false,
                    completion: Deferred.await(gate).pipe(Effect.as({ exitCode, durationMs: 1 })),
                  } as const;
                }),
            }),
      ),
    ),
  );
  const ensure = restore.ensure({ threadId, projectId, worktreePath, branch: "feature" });
  const markerExists = fs.exists(path.join(adminDir, "t3-setup-pending"));
  const holdSetup = Effect.gen(function* () {
    gate = yield* Deferred.make<void>();
    return gate;
  });
  return { calls, ensure, markerExists, holdSetup, setupStarted, worktreePath };
});

// A shell whose line editor is ready at once, and that answers the wrapped setup
// command with its exit code and a prompt.
const fakeShell = (spawnedIn: Array<string>): PtyAdapter.PtyAdapter["Service"] => ({
  spawn: (input) =>
    Effect.sync(() => {
      spawnedIn.push(input.cwd);
      const output = new Set<(data: string) => void>();
      const exits = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
      return {
        pid: 4242,
        write: (data) => {
          const sentinel = /__T3_SETUP_DONE___[0-9a-f]+:/.exec(data)?.[0];
          if (sentinel !== undefined)
            queueMicrotask(() => output.forEach((emit) => emit(`${sentinel}0\r\n$ `)));
        },
        resize: () => undefined,
        kill: () => exits.forEach((exit) => exit({ exitCode: 0, signal: null })),
        onData: (callback) => {
          output.add(callback);
          queueMicrotask(() => callback("$ \x1b[?2004h"));
          return () => output.delete(callback);
        },
        onExit: (callback) => {
          exits.add(callback);
          return () => exits.delete(callback);
        },
      };
    }),
});

it.layer(NodeServices.layer)("WorktreeRestore", (it) => {
  it.effect("recreates a missing worktree and waits for its setup", () =>
    Effect.gen(function* () {
      const h = yield* harness([0]);

      assert.strictEqual(yield* h.ensure, "restored");
      assert.deepStrictEqual(h.calls, { prune: 1, create: 1, setup: 1 });
      assert.isFalse(yield* h.markerExists);

      assert.strictEqual(yield* h.ensure, "present");
      assert.deepStrictEqual(h.calls, { prune: 1, create: 1, setup: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect("restores under the workspace lease, with the real setup terminal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logs = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-restore-logs-" });
      const spawnedIn: Array<string> = [];
      const terminals = yield* TerminalManager.makeWithOptions({
        logsDir: path.join(logs, "terminals"),
        ptyAdapter: fakeShell(spawnedIn),
        subprocessInspector: () =>
          Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
      }).pipe(Effect.provide(ProcessRunner.layer));
      const h = yield* harness([], terminals);

      // The run start holds this lease, and opening a terminal takes it too.
      assert.strictEqual(yield* withWorkspaceLease(h.worktreePath, h.ensure), "restored");
      assert.deepStrictEqual(spawnedIn, [h.worktreePath]);
      assert.isFalse(yield* h.markerExists);
    }).pipe(Effect.scoped),
  );

  it.effect("fails when setup fails, and runs setup again on the next restore", () =>
    Effect.gen(function* () {
      const h = yield* harness([1, 0]);

      const error = yield* Effect.flip(h.ensure);
      assert.strictEqual(error._tag, "WorktreeRestoreError");
      assert.include(error.message, 'the setup script "Setup Worktree" exited with 1');
      assert.isTrue(yield* h.markerExists);

      assert.strictEqual(yield* h.ensure, "restored");
      assert.deepStrictEqual(h.calls, { prune: 1, create: 1, setup: 2 });
      assert.isFalse(yield* h.markerExists);
    }).pipe(Effect.scoped),
  );

  it.effect("threads sharing a worktree wait for one restore", () =>
    Effect.gen(function* () {
      const h = yield* harness([0]);
      const gate = yield* h.holdSetup;

      const first = yield* Effect.forkChild(h.ensure);
      const second = yield* Effect.forkChild(h.ensure);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);

      assert.strictEqual(yield* Fiber.join(first), "restored");
      assert.strictEqual(yield* Fiber.join(second), "restored");
      assert.deepStrictEqual(h.calls, { prune: 1, create: 1, setup: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect("an interrupted restore lets a waiting thread restore instead", () =>
    Effect.gen(function* () {
      const h = yield* harness([0, 0]);
      const gate = yield* h.holdSetup;

      const first = yield* Effect.forkChild(h.ensure);
      yield* Deferred.await(h.setupStarted);
      const second = yield* Effect.forkChild(h.ensure);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(gate, undefined);

      assert.strictEqual(yield* Fiber.join(second), "restored");
      assert.deepStrictEqual(h.calls, { prune: 1, create: 1, setup: 2 });
    }).pipe(Effect.scoped),
  );
});

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import {
  makeRestoreMissingWorktree,
  type WorktreeRecreateError,
  type WorktreeRecreateNoBaseError,
} from "./restoreMissingWorktree.ts";

export class WorktreeRestoreError extends Schema.TaggedError<WorktreeRestoreError>()(
  "WorktreeRestoreError",
  { worktreePath: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not restore the worktree at ${this.worktreePath}: ${this.detail}`;
  }
}

/** File in the worktree's git admin folder while its setup script has not succeeded. */
const SETUP_PENDING_MARKER = "t3-setup-pending";

/**
 * Recreates a worktree storage cleanup removed and runs the project's setup script to completion,
 * so an agent never starts without dependencies. Threads sharing a worktree share one restore; a
 * failed setup reruns next time. Callers hold the worktree's workspace lease.
 */
export class WorktreeRestore extends Context.Service<
  WorktreeRestore,
  {
    readonly ensure: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly worktreePath: string;
      readonly branch: string;
    }) => Effect.Effect<
      "present" | "restored",
      WorktreeRestoreError | WorktreeRecreateError | WorktreeRecreateNoBaseError
    >;
  }
>()("t3/workspace/WorktreeRestore") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const inFlight = new Map<
    string,
    Deferred.Deferred<
      "present" | "restored" | "retry",
      WorktreeRestoreError | WorktreeRecreateError | WorktreeRecreateNoBaseError
    >
  >();

  // A linked worktree's .git file names its admin folder, which git removes with the worktree.
  const markerPath = (worktreePath: string) =>
    fs.readFileString(path.join(worktreePath, ".git")).pipe(
      Effect.map((content) => {
        const gitDir = /^gitdir:\s*(.+)$/m.exec(content)?.[1]?.trim();
        return gitDir === undefined
          ? null
          : path.join(path.resolve(worktreePath, gitDir), SETUP_PENDING_MARKER);
      }),
      Effect.orElseSucceed(() => null),
    );

  const runSetup = Effect.fn("WorktreeRestore.runSetup")(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string;
  }) {
    const fail = (detail: string) =>
      new WorktreeRestoreError({ worktreePath: input.worktreePath, detail });
    const marker = yield* markerPath(input.worktreePath);
    if (marker !== null) yield* fs.writeFileString(marker, "").pipe(Effect.ignore);
    const clearMarker = marker === null ? Effect.void : fs.remove(marker).pipe(Effect.ignore);
    const setup = yield* setupScripts
      .runForThread({
        threadId: input.threadId,
        projectId: input.projectId,
        worktreePath: input.worktreePath,
        // The caller's lease; the setup terminal waiting on it would never open.
        workspaceLeaseHeld: true,
        observeCompletion: {},
      })
      .pipe(Effect.mapError((error) => fail(error.message)));
    if (setup.status !== "started") return yield* clearMarker;
    const completion = setup.completion;
    if (completion === undefined) return yield* clearMarker;
    const settle = completion.pipe(
      Effect.flatMap(({ exitCode }) =>
        exitCode === 0
          ? clearMarker
          : Effect.fail(
              fail(
                `the setup script "${setup.scriptName}" exited with ${exitCode ?? "no exit code"}`,
              ),
            ),
      ),
    );
    // An async script lets the agent start while it runs, as on a new worktree.
    if (setup.async) return yield* settle.pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid);
    yield* settle;
  });

  const restore = Effect.fn("WorktreeRestore.restore")(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string;
    readonly branch: string;
  }) {
    // Marked before anything can interrupt, so a checkout never looks set up when it is not.
    const recreated = yield* restoreMissingWorktree({
      id: input.threadId,
      projectId: input.projectId,
      worktreePath: input.worktreePath,
      branch: input.branch,
    }).pipe(
      Effect.tap((recreated) =>
        recreated
          ? markerPath(input.worktreePath).pipe(
              Effect.flatMap((marker) =>
                marker === null ? Effect.void : fs.writeFileString(marker, "").pipe(Effect.ignore),
              ),
            )
          : Effect.void,
      ),
      Effect.uninterruptible,
    );
    if (!recreated) {
      const marker = yield* markerPath(input.worktreePath);
      const pending =
        marker !== null && (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => false)));
      if (!pending) return "present" as const;
    }
    yield* runSetup(input);
    return "restored" as const;
  });

  // An interrupted restore tells its waiters to try again rather than interrupting them.
  const ensure: WorktreeRestore["Service"]["ensure"] = (input) =>
    Effect.suspend(() => {
      const worktreePath = path.resolve(input.worktreePath);
      const running = inFlight.get(worktreePath);
      if (running !== undefined)
        return Deferred.await(running).pipe(
          Effect.filterOrElse(
            (result): result is "present" | "restored" => result !== "retry",
            () => ensure(input),
          ),
        );
      const done = Deferred.makeUnsafe<
        "present" | "restored" | "retry",
        WorktreeRestoreError | WorktreeRecreateError | WorktreeRecreateNoBaseError
      >();
      inFlight.set(worktreePath, done);
      // The path goes to git as given; a raw path is not a managed worktree.
      return restore(input).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            inFlight.delete(worktreePath);
            Deferred.doneUnsafe(
              done,
              Exit.isFailure(exit) && Exit.hasInterrupts(exit) ? Exit.succeed("retry") : exit,
            );
          }),
        ),
      );
    });

  return WorktreeRestore.of({ ensure });
});

export const layer = Layer.effect(WorktreeRestore, make);

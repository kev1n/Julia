import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";

export class WorktreeRestoreError extends Schema.TaggedError<WorktreeRestoreError>()(
  "WorktreeRestoreError",
  {
    worktreePath: Schema.String,
    detail: Schema.String,
    /** Set when git could not recreate the checkout; its diagnostic stays out of the message. */
    branch: Schema.optional(Schema.String),
    noBase: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    if (this.noBase === true)
      return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
    if (this.branch !== undefined)
      return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
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
    }) => Effect.Effect<"present" | "restored", WorktreeRestoreError>;
  }
>()("t3/workspace/WorktreeRestore") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const inFlight = new Map<
    string,
    Deferred.Deferred<"present" | "restored" | "retry", WorktreeRestoreError>
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

  const resolveRecreateBase = Effect.fn("WorktreeRestore.resolveRecreateBase")(function* (
    cwd: string,
  ) {
    // Recovery can follow an external checkout, before the status cache expires.
    yield* git.invalidateLocalStatus(cwd);
    const { refName: currentBranch } = yield* git.localStatus({ cwd });
    if (currentBranch !== null) {
      const refName = `refs/heads/${currentBranch}`;
      return { refName, baseRefName: refName };
    }
    if (yield* git.hasCommit({ cwd, refName: "refs/remotes/origin/HEAD" })) {
      const { commitSha } = yield* git.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: "origin",
      });
      // Start from the commit so the thread branch does not track the default branch.
      return { refName: commitSha, baseRefName: "refs/remotes/origin/HEAD" };
    }
    if (yield* git.hasCommit({ cwd, refName: "HEAD" })) {
      return { refName: "HEAD", baseRefName: undefined };
    }
    return null;
  });

  const restore = Effect.fn("WorktreeRestore.restore")(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string;
    readonly branch: string;
  }) {
    const fail = (detail: string) =>
      new WorktreeRestoreError({ worktreePath: input.worktreePath, detail });
    const exists = yield* fs.exists(input.worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists) {
      const marker = yield* markerPath(input.worktreePath);
      const pending =
        marker !== null && (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => false)));
      if (!pending) return "present" as const;
    } else {
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((error) => fail(error.message)),
      );
      if (project === undefined) return yield* fail("its project is unavailable");
      yield* Effect.logWarning("recreating a missing worktree", {
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        branch: input.branch,
      });
      const cwd = project.workspaceRoot;
      const { worktreePath, branch } = input;
      yield* Effect.gen(function* () {
        yield* git.pruneWorktrees({ cwd });
        // Push keeps the tracking ref current, so recovery reads it without fetching.
        const pushedRef = `refs/remotes/origin/${branch}`;
        if ((yield* git.listLocalBranchNames(cwd)).includes(branch)) {
          yield* git.createWorktree({ cwd, refName: branch, path: worktreePath });
        } else if (yield* git.hasCommit({ cwd, refName: pushedRef })) {
          yield* git.createWorktree({
            cwd,
            refName: pushedRef,
            newRefName: branch,
            path: worktreePath,
          });
        } else {
          const base = yield* resolveRecreateBase(cwd);
          if (base === null) {
            return yield* new WorktreeRestoreError({
              worktreePath,
              detail: "no commit to start from",
              branch,
              noBase: true,
            });
          }
          yield* git.createWorktree({
            cwd,
            refName: base.refName,
            newRefName: branch,
            ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
            path: worktreePath,
          });
        }
        // Marked before anything can interrupt, so a checkout never looks set up when it is not.
        const marker = yield* markerPath(worktreePath);
        if (marker !== null) yield* fs.writeFileString(marker, "").pipe(Effect.ignore);
      }).pipe(
        Effect.uninterruptible,
        Effect.tapError((error) =>
          error._tag === "WorktreeRestoreError"
            ? Effect.void
            : Effect.logWarning("recreating a missing worktree failed", { worktreePath, error }),
        ),
        Effect.mapError((error) =>
          error._tag === "WorktreeRestoreError"
            ? error
            : new WorktreeRestoreError({ worktreePath, detail: "git could not create it", branch }),
        ),
      );
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
      const done = Deferred.makeUnsafe<"present" | "restored" | "retry", WorktreeRestoreError>();
      inFlight.set(worktreePath, done);
      return restore({ ...input, worktreePath }).pipe(
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

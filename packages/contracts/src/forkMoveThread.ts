/**
 * Fork (Owner): the target side of "Move to another machine". The client asks
 * the target environment to take a thread's branch from the source
 * environment; the target fetches it from the source over the fleet's
 * machine-to-machine channel as a git bundle. No git remote is involved.
 */
import * as Schema from "effect/Schema";

export const ForkMoveReceiveInput = Schema.Struct({
  sourceEnvironmentId: Schema.String,
  /** The source thread's own worktree (never a project checkout). */
  sourceWorktreePath: Schema.String,
  branch: Schema.String,
  /** The target project's checkout that receives the branch. */
  projectRoot: Schema.String,
  /** Message of the commit that carries uncommitted work, if there is any. */
  commitMessage: Schema.String,
});
export type ForkMoveReceiveInput = typeof ForkMoveReceiveInput.Type;

export const ForkMoveReceiveResult = Schema.Struct({
  /** Free branch name on the target: the source's, or `<branch>-<n>` when taken. */
  branch: Schema.String,
  /** The moved commit, present in the target repository but not on any ref yet. */
  commit: Schema.String,
});
export type ForkMoveReceiveResult = typeof ForkMoveReceiveResult.Type;

export class ForkMoveError extends Schema.TaggedError<ForkMoveError>()("ForkMoveError", {
  message: Schema.String,
}) {}

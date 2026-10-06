// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork (Owner): free disk on the home volume, where T3 keeps its data and
 * thread worktrees. Reported with host resources so Auto placement can break
 * ties toward the machine with more room. Null when the volume cannot be read.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";

export const readFreeDiskBytes: Effect.Effect<number | null> = Effect.tryPromise(() =>
  NodeFSP.statfs(NodeOS.homedir()),
).pipe(
  Effect.map((stats) => {
    const bytes = stats.bavail * stats.bsize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  }),
  Effect.orElseSucceed(() => null),
);

// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: free and total disk on the home volume, where T3 keeps its data
 * and thread worktrees. Reported with host resources so Auto placement can
 * break ties toward the machine with more room, and Usage > Machines can show
 * disk used of total. Each field is left out when the volume cannot be read.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";

const bytesOrNull = (bytes: number) => (Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null);

export const readDiskBytes: Effect.Effect<{
  readonly freeDiskBytes?: number;
  readonly totalDiskBytes?: number;
}> = Effect.tryPromise(() => NodeFSP.statfs(NodeOS.homedir())).pipe(
  Effect.map((stats) => {
    const free = bytesOrNull(stats.bavail * stats.bsize);
    const total = bytesOrNull(stats.blocks * stats.bsize);
    return {
      ...(free === null ? {} : { freeDiskBytes: free }),
      ...(total === null ? {} : { totalDiskBytes: total }),
    };
  }),
  Effect.orElseSucceed(() => ({})),
);

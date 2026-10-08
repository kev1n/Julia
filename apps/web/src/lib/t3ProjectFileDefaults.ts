import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "~/connection/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

function toT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  result: ProjectReadFileResult | null,
): T3ProjectFile | null {
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    result,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseT3ProjectFile(data.contents);
}

/**
 * Defaults are optional: an unavailable or lost connection must not pin a
 * local New Thread action to that machine's recovery.
 */
export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  const read = connectionAtomRuntime.atom(
    Effect.gen(function* () {
      const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
      return yield* environments.run(
        environmentId,
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
          const state = yield* SubscriptionRef.get(supervisor.state);
          const session = yield* SubscriptionRef.get(supervisor.session);
          if (state.phase !== "connected" || Option.isNone(session)) return null;
          const disconnected = SubscriptionRef.changes(supervisor.state).pipe(
            Stream.zipLatest(SubscriptionRef.changes(supervisor.session)),
            Stream.filter(
              ([state, session]) => state.phase !== "connected" || Option.isNone(session),
            ),
            Stream.runHead,
            Effect.as(null),
          );
          return yield* Effect.raceFirst(
            Effect.promise((signal) => readProjectFile(environmentId, workspaceRoot, signal)),
            disconnected,
          );
        }),
      );
    }),
  );
  const result = await executeAtomQuery(appAtomRegistry, read, {
    reportDefect: false,
    reportFailure: false,
  });
  return result._tag === "Success" ? result.value : null;
}

/** Waits for the machine to connect, like any environment query; a paired project can list before it does. */
export async function readT3ProjectFileOnceConnected(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<T3ProjectFile | null> {
  return readProjectFile(environmentId, workspaceRoot, signal);
}

async function readProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  signal: AbortSignal | undefined,
): Promise<T3ProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false, signal },
  );
  return toT3ProjectFile(
    environmentId,
    workspaceRoot,
    result._tag === "Success" ? result.value : null,
  );
}

/** The project's t3.json from an earlier read, or `undefined` when none has loaded yet. */
export function peekT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): T3ProjectFile | null | undefined {
  const result = appAtomRegistry.get(
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
  );
  return AsyncResult.isSuccess(result)
    ? toT3ProjectFile(environmentId, workspaceRoot, result.value)
    : undefined;
}

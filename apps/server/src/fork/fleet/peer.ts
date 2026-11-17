// @effect-diagnostics globalDate:off
/**
 * Fork: who a peer request comes from. The source server vouches for
 * the calling thread; the receiving server acts for it as a client whose
 * permission ceiling is that thread's runtime mode.
 */
import {
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { clientModeCeiling, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { type FleetConfig, FleetOperationError, fleetRequest } from "./config.ts";
import type { FleetSnapshot } from "./model.ts";

export const PeerSource = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  runtimeMode: RuntimeMode,
});
export type PeerSource = typeof PeerSource.Type;

export const peerScope = (environmentId: string, source: PeerSource): McpInvocationScope => ({
  environmentId: environmentId as McpInvocationScope["environmentId"],
  capabilities: new Set(["orchestration"]),
  issuedAt: Date.now(),
  requestNamespace: `fleet:${source.environmentId}:${source.threadId}`,
  thread: undefined,
  client: {
    sessionId: `fleet:${source.environmentId}:${source.threadId}`,
    label: `${source.label} · ${source.title}`,
    access: source.runtimeMode,
  },
});

/** The caller as a peer hears of it: its thread, or the client when no thread is calling. */
export const peerSourceOf = (
  self: { readonly environmentId: string; readonly label: string },
  scope: McpInvocationScope,
  caller: OrchestrationV2ThreadShell | undefined,
): PeerSource => ({
  environmentId: self.environmentId,
  label: self.label,
  threadId: caller?.id ?? `client:${scope.client?.sessionId ?? "unknown"}`,
  title: caller?.title ?? scope.client?.label ?? "client",
  runtimeMode: caller?.runtimeMode ?? clientModeCeiling(scope.client).runtimeMode,
});

export type PeerReply<A> =
  | { readonly ok: true; readonly result: A }
  | {
      readonly ok: false;
      readonly failure: { code: OrchestratorMcpFailure["code"]; message: string };
    };

/** One request to the machine that owns a thread; a failure names that machine. */
export const askPeer = <A>(
  config: FleetConfig,
  target: FleetSnapshot,
  path: string,
  body: unknown,
) =>
  Effect.tryPromise({
    try: () => fleetRequest(config, `${target.baseUrl}/fork/fleet/${path}`, body),
    catch: (cause) => new FleetOperationError({ cause }),
  }).pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `${target.label} did not answer: ${String(error.cause ?? error)}`,
        }),
    ),
    Effect.flatMap((reply) => {
      const typed = reply as PeerReply<A>;
      return typed.ok
        ? Effect.succeed(typed.result)
        : Effect.fail(
            new OrchestratorMcpFailure({
              code: typed.failure.code,
              message: `${target.label}: ${typed.failure.message}`,
            }),
          );
    }),
  );

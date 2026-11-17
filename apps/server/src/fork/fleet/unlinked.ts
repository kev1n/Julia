/**
 * Fork: a fleet machine's threads need no link to be read. Clients ask which machines those
 * are (`fork.fleetMachines`), so a composer offers their threads, and a `t3_thread_read` naming
 * one goes over the fleet channel (PeerForwarding).
 */
import {
  EnvironmentId,
  type ForkFleetMachine,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { unavailable } from "../../mcp/threadAccess.ts";
import type { FleetConfig } from "./config.ts";
import type { FleetSnapshot } from "./model.ts";
import { askPeer, peerSourceOf } from "./peer.ts";
import { loadView } from "./view.ts";

const encodeRead = Schema.encodeEffect(OrchestratorMcpThreadReadInput);
const decodeResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);

/** The fleet's machines other than this one, stale ones too; none while the fleet is off. */
export const fleetMachines = (config: FleetConfig | null, local: FleetSnapshot | null) =>
  Effect.promise(() => loadView(config, local)).pipe(
    Effect.map((view) =>
      view.entries.flatMap(({ snapshot }): Array<ForkFleetMachine> =>
        snapshot.environmentId === local?.environmentId
          ? []
          : [{ environmentId: EnvironmentId.make(snapshot.environmentId), label: snapshot.label }],
      ),
    ),
  );

/**
 * `t3_thread_read` answered by the fleet machine that owns the thread, for `caller` here. None
 * when the fleet is off or does not list that machine, so the read can still go over a link.
 */
export const readFleetThread = Effect.fn("fork.fleet.readFleetThread")(function* (input: {
  readonly config: FleetConfig | null;
  readonly local: FleetSnapshot | null;
  readonly scope: McpInvocationScope;
  readonly caller: OrchestrationV2ThreadShell | undefined;
  readonly environmentId: string;
  readonly read: OrchestratorMcpThreadReadInput;
}) {
  const { config, local, scope } = input;
  if (config === null) return Option.none<OrchestratorMcpThreadReadResult>();
  const view = yield* Effect.promise(() => loadView(config, local));
  const target = view.entries.find(
    (entry) => entry.snapshot.environmentId === input.environmentId,
  )?.snapshot;
  if (target === undefined) return Option.none<OrchestratorMcpThreadReadResult>();
  // The owner reads its own thread, so the machine the call named stays here.
  const { environmentId: _target, ...read } = yield* encodeRead(input.read).pipe(
    Effect.mapError(unavailable),
  );
  const answered = yield* askPeer<unknown>(config, target, "peer/read", {
    source: peerSourceOf(
      { environmentId: scope.environmentId, label: local?.label ?? scope.environmentId },
      scope,
      input.caller,
    ),
    input: read,
  });
  return Option.some(yield* decodeResult(answered).pipe(Effect.mapError(unavailable)));
});

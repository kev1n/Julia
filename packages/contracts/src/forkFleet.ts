/**
 * Fork: the other machines in a server's fleet (`fork-fleet.json`). Its agents read their
 * threads over the fleet channel without a link, so a composer there may attach them.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";

export const ForkFleetMachine = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
});
export type ForkFleetMachine = typeof ForkFleetMachine.Type;

export const ForkFleetMachinesResult = Schema.Struct({
  machines: Schema.Array(ForkFleetMachine),
});
export type ForkFleetMachinesResult = typeof ForkFleetMachinesResult.Type;

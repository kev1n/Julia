/**
 * Fork: Auto's machine for a new thread: connected, hosting the project, provider usable
 * and on for Auto (weight 0, or a laptop with no saved preference, is off). Ranked by available
 * memory, then fewer running threads, then free disk; with none eligible the user picks.
 */
import { type EnvironmentMachineKind, resolveEnvironmentMachineKind } from "@t3tools/contracts";

/** The weight Auto uses for a machine that has no saved preference. */
export function defaultAutoWeight(kind: EnvironmentMachineKind): number {
  return kind === "laptop" ? 0 : 50;
}

export function autoWeight(
  weights: Readonly<Record<string, number>>,
  environmentId: string,
  kind: EnvironmentMachineKind,
): number {
  return weights[environmentId] ?? defaultAutoWeight(kind);
}

export interface MachineFacts {
  readonly environmentId: string;
  readonly label: string;
  readonly availableMemoryBytes: number;
  readonly runningThreadCount: number;
  /** Null on servers that do not report free disk. */
  readonly freeDiskBytes: number | null;
}

export type MachineDecision =
  | { readonly kind: "chosen"; readonly environmentId: string; readonly reason: string }
  | { readonly kind: "none"; readonly reason: string };

function compareDisk(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

function compareMachines(left: MachineFacts, right: MachineFacts): number {
  return (
    right.availableMemoryBytes - left.availableMemoryBytes ||
    left.runningThreadCount - right.runningThreadCount ||
    compareDisk(left.freeDiskBytes, right.freeDiskBytes)
  );
}

/** Why the winner beat the runner-up, naming the first rule that separated them. */
function reasonOver(winner: MachineFacts, runnerUp: MachineFacts | undefined): string {
  if (!runnerUp) return "only eligible machine";
  if (winner.availableMemoryBytes !== runnerUp.availableMemoryBytes) return "most free memory";
  if (winner.runningThreadCount !== runnerUp.runningThreadCount) return "fewest running threads";
  if (compareDisk(winner.freeDiskBytes, runnerUp.freeDiskBytes) !== 0) return "most free disk";
  return `tied with ${runnerUp.label}`;
}

export function chooseAutoMachine(candidates: ReadonlyArray<MachineFacts>): MachineDecision {
  const ranked = candidates
    .map((facts, index) => ({ facts, index }))
    .sort((left, right) => compareMachines(left.facts, right.facts) || left.index - right.index);
  const winner = ranked[0]?.facts;
  if (!winner) return { kind: "none", reason: "No eligible machine is online" };
  return {
    kind: "chosen",
    environmentId: winner.environmentId,
    reason: reasonOver(winner, ranked[1]?.facts),
  };
}

/** Every listed machine's weight with the fork default filled in, for the settings rows. */
export function effectiveAutoWeights(
  environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly serverConfig: Parameters<typeof resolveEnvironmentMachineKind>[0];
  }>,
  weights: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    environments.map(({ environmentId, serverConfig }) => [
      environmentId,
      autoWeight(weights, environmentId, resolveEnvironmentMachineKind(serverConfig)),
    ]),
  );
}

export const AUTO_PLACEMENT_DESCRIPTION =
  "New threads start on the eligible machine with the most free memory, then the fewest running threads, then the most free disk, using the provider account with the most session usage left. Laptops are Manual only until you set them; any other preference makes a machine eligible.";

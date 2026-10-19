import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

const withLease = <A, E, R>(
  cwd: string,
  use: (semaphore: Semaphore.Semaphore) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return use(lease.semaphore).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(cwd);
        }),
      ),
    );
  });

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => withLease(cwd, (semaphore) => semaphore.withPermit(effect));

/** Runs `effect` only if the lease is free now; `None` while another holder has it. */
export const withWorkspaceLeaseIfAvailable = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
  withLease(cwd, (semaphore) => semaphore.withPermitsIfAvailable(1)(effect));

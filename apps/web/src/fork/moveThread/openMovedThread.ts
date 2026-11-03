/**
 * Fork: open the moved thread only once this client knows it. A thread route without its
 * shell redirects to a new draft, and the target's shell stream can lag the move's launch;
 * upstream's fork-from-run waits the same way (`waitForThreadShell`).
 */
import type { Atom, AtomRegistry } from "effect/reactivity";

import { waitForAtomValue } from "../../state/waitForAtomValue";

/** Upstream's wait for a new thread's shell (`waitForThreadShell` in state/entities.ts). */
const SHELL_WAIT_MS = 5_000;

export async function openMovedThread(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  /** The moved thread's shell as this client sees it (null until the stream delivers it). */
  readonly shell: Atom.Atom<unknown>;
  readonly navigate: () => Promise<void>;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const known = await waitForAtomValue({
    registry: input.registry,
    atom: input.shell,
    predicate: (shell) => shell !== null,
    timeoutMs: input.timeoutMs ?? SHELL_WAIT_MS,
  });
  if (known) await input.navigate();
  return known;
}

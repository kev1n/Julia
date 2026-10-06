import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { openMovedThread } from "./openMovedThread";

describe("openMovedThread", () => {
  it("navigates only once the moved thread's shell has reached the client", async () => {
    const registry = AtomRegistry.make();
    const shell = Atom.make<{ readonly id: string } | null>(null);
    const seenAtNavigation: Array<unknown> = [];
    const opened = openMovedThread({
      registry,
      shell,
      navigate: async () => {
        seenAtNavigation.push(registry.get(shell));
      },
    });

    await Promise.resolve();
    expect(seenAtNavigation).toEqual([]);
    registry.set(shell, { id: "moved" });

    await expect(opened).resolves.toBe(true);
    // The route then renders the thread instead of redirecting to a new draft.
    expect(seenAtNavigation).toEqual([{ id: "moved" }]);
    registry.dispose();
  });

  it("does not navigate when the shell never arrives", async () => {
    vi.useFakeTimers();
    const registry = AtomRegistry.make();
    const shell = Atom.make<{ readonly id: string } | null>(null);
    const navigate = vi.fn(async () => {});
    const opened = openMovedThread({ registry, shell, navigate, timeoutMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(opened).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    registry.dispose();
    vi.useRealTimers();
  });
});

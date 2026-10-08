import { StrictMode, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

type Notice = {
  title: string;
  timeout: number;
  onClose: () => void;
  actionProps: { children: string; onClick: () => void };
  data: { onClose: () => void };
};

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    connection: { phase: string };
    serverConfig: { environment: { serverVersion: string } };
  }>,
  environmentListeners: new Set<() => void>(),
  storage: new Map<string, unknown>(),
  active: new Map<string, Notice>(),
  nextId: 0,
  add: vi.fn<(notice: Notice) => string>(),
  update: vi.fn<(id: string, notice: Notice) => void>(),
  close: vi.fn<(id: string) => void>(),
}));

vi.mock("../branding", () => ({ APP_VERSION: "0.0.46-nightly.20261007.2787" }));
// Subscribed like the real hook: the React Compiler memoizes the notice's subtree, so a
// rerender alone would not make it read new environments.
vi.mock("../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.environmentListeners.add(listener);
    return () => state.environmentListeners.delete(listener);
  };
  return {
    useEnvironments: () => ({
      environments: useSyncExternalStore(subscribe, () => state.environments),
    }),
  };
});
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: (key: string) => state.storage.get(key) ?? null,
  setLocalStorageItem: (key: string, value: unknown) => state.storage.set(key, value),
}));
vi.mock("@base-ui/react/toast", () => ({
  Toast: {
    createToastManager: () => ({ add: state.add, update: state.update, close: state.close }),
    useToastManager: () => ({ add: state.add, update: state.update, close: state.close }),
  },
}));
vi.mock("./ui/toast", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ServerUpdateReviewDialog", () => ({ ServerUpdateReviewDialog: () => null }));

import { ServerUpdateNotice } from "./ServerUpdateNotice";

const machine = (environmentId: string, version = "0.0.46-nightly.20261007.2761") => ({
  environmentId,
  connection: { phase: "connected" },
  serverConfig: { environment: { serverVersion: version } },
});

async function setEnvironments(next: typeof state.environments) {
  await act(() => {
    state.environments = next;
    for (const listener of state.environmentListeners) listener();
  });
}

function setup() {
  state.environments = [];
  state.storage.clear();
  state.active.clear();
  state.nextId = 0;
  state.add.mockReset().mockImplementation((notice) => {
    const id = `notice-${++state.nextId}`;
    state.active.set(id, notice);
    return id;
  });
  state.update.mockReset().mockImplementation((id, notice) => {
    state.active.set(id, notice);
  });
  state.close.mockReset().mockImplementation((id) => {
    const notice = state.active.get(id);
    state.active.delete(id);
    notice?.onClose();
  });
}

it("keeps one corner notice as machines change", async () => {
  setup();
  state.environments = [machine("build-mac"), machine("mac-a")];
  await using _screen = await render(<ServerUpdateNotice />);
  expect(state.active.size).toBe(1);
  const id = state.add.mock.results[0]!.value;
  expect(state.active.get(id)).toMatchObject({
    title: "Update available",
  });

  await setEnvironments([machine("mac-a"), machine("MacBook")]);
  expect(state.add).toHaveBeenCalledTimes(1);
  expect(state.active.size).toBe(1);
});

it("remembers dismissal across remounts but shows a genuinely different version", async () => {
  setup();
  state.environments = [machine("build-mac"), machine("mac-a")];
  {
    await using _first = await render(<ServerUpdateNotice />);
    await act(() => state.close(state.add.mock.results[0]!.value));
    expect(state.active.size).toBe(0);
  }
  await using _screen = await render(<ServerUpdateNotice />);
  expect(state.active.size).toBe(0);

  await setEnvironments([machine("build-mac", "0.0.46-nightly.20261007.2770")]);
  expect(state.active.size).toBe(1);
});

it("removes resolved/offline notices without treating reconnects as user dismissals", async () => {
  setup();
  state.environments = [machine("build-mac")];
  await using _screen = await render(<ServerUpdateNotice />);
  await setEnvironments([{ ...machine("build-mac"), connection: { phase: "reconnecting" } }]);
  expect(state.active.size).toBe(0);
  expect(state.storage.size).toBe(0);

  await setEnvironments([machine("build-mac")]);
  expect(state.active.size).toBe(1);
  await setEnvironments([machine("build-mac", "0.0.46-nightly.20261007.2787")]);
  expect(state.active.size).toBe(0);
});

it("does not leak a duplicate or dismiss the update during Strict Mode effect replay", async () => {
  setup();
  state.environments = [machine("build-mac")];
  await using _screen = await render(
    <StrictMode>
      <ServerUpdateNotice />
    </StrictMode>,
  );
  expect(state.active.size).toBe(1);
  expect(state.storage.size).toBe(0);
});

import { StrictMode, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
  storage: new Map<string, unknown>(),
  active: new Map<string, Notice>(),
  nextId: 0,
  navigate: vi.fn(),
  add: vi.fn<(notice: Notice) => string>(),
  update: vi.fn<(id: string, notice: Notice) => void>(),
  close: vi.fn<(id: string) => void>(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../branding", () => ({ APP_VERSION: "0.0.46-nightly.20261007.2787" }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: (key: string) => state.storage.get(key) ?? null,
  setLocalStorageItem: (key: string, value: unknown) => state.storage.set(key, value),
}));
vi.mock("@base-ui/react/toast", () => ({
  Toast: {
    createToastManager: () => ({ add: state.add, update: state.update, close: state.close }),
  },
}));
vi.mock("./ui/toast", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

import { ServerUpdateNotice } from "./ServerUpdateNotice";

let renderer: ReactTestRenderer | undefined;
const machine = (environmentId: string, version = "0.0.46-nightly.20261007.2761") => ({
  environmentId,
  connection: { phase: "connected" },
  serverConfig: { environment: { serverVersion: version } },
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environments = [];
  state.storage.clear();
  state.active.clear();
  state.nextId = 0;
  state.navigate.mockReset();
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
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function refresh() {
  await act(async () => renderer!.update(<ServerUpdateNotice />));
}

it("keeps one corner notice as machines change, with update controls reachable in Settings", async () => {
  state.environments = [machine("build-mac"), machine("mac-a")];
  await act(async () => {
    renderer = create(<ServerUpdateNotice />);
  });
  expect(state.active.size).toBe(1);
  const id = state.add.mock.results[0]!.value;
  expect(state.active.get(id)).toMatchObject({
    title: "Update available",
  });

  state.environments = [machine("mac-a"), machine("MacBook")];
  await refresh();
  expect(state.add).toHaveBeenCalledTimes(1);
  expect(state.active.size).toBe(1);
  state.active.get(id)!.actionProps.onClick();
  expect(state.navigate).toHaveBeenCalledWith({ to: "/settings/connections" });
});

it("remembers dismissal across remounts but shows a genuinely different version", async () => {
  state.environments = [machine("build-mac"), machine("mac-a")];
  await act(async () => {
    renderer = create(<ServerUpdateNotice />);
  });
  await act(async () => state.close(state.add.mock.results[0]!.value));
  expect(state.active.size).toBe(0);
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(<ServerUpdateNotice />);
  });
  expect(state.active.size).toBe(0);

  state.environments = [machine("build-mac", "0.0.46-nightly.20261007.2770")];
  await refresh();
  expect(state.active.size).toBe(1);
});

it("removes resolved/offline notices without treating reconnects as user dismissals", async () => {
  state.environments = [machine("build-mac")];
  await act(async () => {
    renderer = create(<ServerUpdateNotice />);
  });
  state.environments = [{ ...machine("build-mac"), connection: { phase: "reconnecting" } }];
  await refresh();
  expect(state.active.size).toBe(0);
  expect(state.storage.size).toBe(0);

  state.environments = [machine("build-mac")];
  await refresh();
  expect(state.active.size).toBe(1);
  state.environments = [machine("build-mac", "0.0.46-nightly.20261007.2787")];
  await refresh();
  expect(state.active.size).toBe(0);
});

it("does not leak a duplicate or dismiss the update during Strict Mode effect replay", async () => {
  state.environments = [machine("build-mac")];
  await act(async () => {
    renderer = create(
      <StrictMode>
        <ServerUpdateNotice />
      </StrictMode>,
    );
  });
  expect(state.active.size).toBe(1);
  expect(state.storage.size).toBe(0);
});

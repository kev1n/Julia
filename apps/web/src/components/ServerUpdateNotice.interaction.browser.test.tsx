import { StrictMode } from "react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    label: string;
    connection: { phase: string };
    serverConfig: {
      settings: { continueThreadsAfterServerUpdate: boolean };
      environment: {
        serverVersion: string;
        capabilities: {
          serverSelfUpdate: "boot-service" | null;
          serverUpdateThreadContinuation?: boolean;
        };
      };
    };
  }>,
  environmentListeners: new Set<() => void>(),
  registry: null as AtomRegistry.AtomRegistry | null,
  sessionAtom: Symbol("session"),
  session: null as unknown,
  updateServer: vi.fn(),
  clipboard: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useParams: (() => null) as never,
}));
vi.mock("../branding", () => ({ APP_VERSION: "0.0.46-nightly.20261007.2787" }));
// The mocked hooks subscribe like the real ones: the React Compiler memoizes the notice's
// subtree, so only a store notification makes it read changed environments or atoms.
vi.mock("../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.environmentListeners.add(listener);
    return () => state.environmentListeners.delete(listener);
  };
  const useEnvironmentList = () => useSyncExternalStore(subscribe, () => state.environments);
  return {
    useEnvironments: () => ({ environments: useEnvironmentList() }),
    useEnvironment: (id: string) =>
      useEnvironmentList().find((environment) => environment.environmentId === id) ?? null,
    usePrimaryEnvironmentId: vi.fn(),
  };
});
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => null,
  setLocalStorageItem: vi.fn(),
}));
// Not spread from the real module: it imports ~/lib/utils, which imports DraftId from here.
vi.mock("~/composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: () => null,
    clearComposerDraftsEnvironment: vi.fn(),
  };
});
vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAtomValue: (atom: unknown) =>
      useSyncExternalStore(
        (listener) =>
          atom === state.sessionAtom
            ? () => {}
            : state.registry!.subscribe(atom as Atom.Atom<unknown>, listener),
        () =>
          atom === state.sessionAtom
            ? state.session
            : state.registry!.get(atom as Atom.Atom<unknown>),
      ),
  };
});
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
// Any other atom read here is the server-config map, which has no managed policy.
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => (atom === state.sessionAtom ? state.session : new Map()),
  },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    updateStateAtom: (id: string) => updateStateAtoms(id),
    updateServer: Symbol("updateServer"),
  },
  updateOutdatedServer: vi.fn(),
  environmentServerConfigsAtom: vi.fn(),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.updateServer }));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => false }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: state.clipboard, isCopied: false }),
}));

import { ServerUpdateNotice } from "./ServerUpdateNotice";

const updateStateAtoms = Atom.family((_id: string) =>
  Atom.make<{ status: "idle" | "running"; stage?: "resuming" }>({ status: "idle" }),
);
const machine = (environmentId: string, version = "0.0.46-nightly.20261007.2761") => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: {
    settings: { continueThreadsAfterServerUpdate: false },
    environment: {
      serverVersion: version,
      capabilities: { serverSelfUpdate: "boot-service" as const },
    },
  },
});

function setup(): Disposable {
  const registry = AtomRegistry.make();
  state.environments = [];
  state.registry = registry;
  state.session = AsyncResult.success({
    authenticated: true,
    scopes: ["environment:maintain"],
    auth: { serverUpdateScope: "environment:maintain" },
  });
  state.updateServer.mockReset().mockResolvedValue(
    AsyncResult.success({
      targetVersion: "0.0.46-nightly.20261007.2787",
      method: "boot-service",
    }),
  );
  state.clipboard.mockReset();
  return { [Symbol.dispose]: () => registry.dispose() };
}

function renderNotice() {
  return render(
    <StrictMode>
      <ServerUpdateNotice />
    </StrictMode>,
  );
}

/** Applies environment and atom changes the way live state arrives: as store notifications. */
async function change(apply: () => void) {
  await act(() => {
    apply();
    for (const listener of state.environmentListeners) listener();
  });
}

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) =>
      !element.closest("[data-ending-style]") &&
      (element.textContent === label || element.getAttribute("aria-label") === label),
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(() => button!.click());
}

it("opens update controls from the rendered Review button and follows the chosen machine through restart", async () => {
  using _registry = setup();
  state.environments = [machine("build-mac"), machine("mac-a")];
  await using _screen = await renderNotice();
  expect(
    document.querySelectorAll('[role="dialog"]:not([data-ending-style]) [data-slot="toast-action"]')
      .length,
  ).toBe(1);
  await click("Review");
  const dialog = () => document.querySelector('[data-slot="dialog-popup"][data-open]');
  expect(dialog()?.textContent).toContain("Update T3 Code servers");
  expect(dialog()?.textContent).toContain("mac-a");
  expect(dialog()?.textContent).toContain(
    "0.0.46-nightly.20261007.2761 → 0.0.46-nightly.20261007.2787",
  );
  await click("Update");
  expect(state.updateServer).toHaveBeenCalledExactlyOnceWith({
    environmentId: "build-mac",
    input: { targetVersion: "0.0.46-nightly.20261007.2787" },
  });

  await change(() => {
    state.registry!.set(updateStateAtoms("build-mac"), { status: "running", stage: "resuming" });
    state.environments = [
      { ...machine("build-mac"), connection: { phase: "reconnecting" } },
      machine("mac-a"),
    ];
  });
  expect(dialog()?.textContent).toContain("Restarting…");
  await change(() => {
    state.registry!.set(updateStateAtoms("build-mac"), { status: "idle" });
    state.environments = [machine("build-mac", "0.0.46-nightly.20261007.2787"), machine("mac-a")];
  });
  expect(dialog()?.textContent).toContain("Up to date");
  await click("Close");
  await click("Review");
  expect(dialog()?.textContent).not.toContain("build-mac");
});

it("offers a manual relaunch command when the server cannot self-update", async () => {
  using _registry = setup();
  const manualMachine = machine("manual");
  state.environments = [
    {
      ...manualMachine,
      serverConfig: {
        settings: manualMachine.serverConfig.settings,
        environment: {
          ...manualMachine.serverConfig.environment,
          capabilities: { serverSelfUpdate: null },
        },
      },
    },
  ];
  await using _screen = await renderNotice();
  await click("Review");
  await click("Copy relaunch command");
  expect(state.clipboard).toHaveBeenCalledWith("npx t3@0.0.46-nightly.20261007.2787", {
    command: "npx t3@0.0.46-nightly.20261007.2787",
  });
  expect(state.updateServer).not.toHaveBeenCalled();
});

it("updates all eligible machines concurrently and skips manual, offline, running, and updated machines", async () => {
  using _registry = setup();
  const manual = machine("manual");
  state.environments = [
    machine("build-mac"),
    machine("mac-a"),
    machine("offline"),
    machine("running"),
    machine("updated"),
    {
      ...manual,
      serverConfig: {
        ...manual.serverConfig,
        environment: {
          ...manual.serverConfig.environment,
          capabilities: { serverSelfUpdate: null },
        },
      },
    },
  ];
  state.environments[0]!.serverConfig.settings.continueThreadsAfterServerUpdate = true;
  state.environments[0]!.serverConfig.environment.capabilities.serverUpdateThreadContinuation = true;
  await using _screen = await renderNotice();
  await click("Review");
  await change(() => {
    state.environments = state.environments.map((environment) =>
      environment.environmentId === "offline"
        ? { ...environment, connection: { phase: "reconnecting" } }
        : environment.environmentId === "updated"
          ? machine("updated", "0.0.46-nightly.20261007.2787")
          : environment,
    );
    state.registry!.set(updateStateAtoms("running"), { status: "running", stage: "resuming" });
  });

  let finishFirst!: () => void;
  state.updateServer.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = () =>
          resolve(
            AsyncResult.success({
              targetVersion: "0.0.46-nightly.20261007.2787",
              method: "boot-service",
            }),
          );
      }),
  );
  await click("Update all");
  expect(state.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
    "build-mac",
    "mac-a",
  ]);
  expect(state.updateServer.mock.calls[0]?.[0].input).toEqual({
    targetVersion: "0.0.46-nightly.20261007.2787",
  });
  const bulkButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Update all",
  );
  expect(bulkButton?.disabled).toBe(true);
  await act(() => finishFirst());
});

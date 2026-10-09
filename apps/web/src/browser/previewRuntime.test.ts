import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  desktop: false,
  primary: null as string | null,
  serverBrowser: new Set<string>(),
}));

vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => state.desktop }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.primary } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: (id: string) => state.serverBrowser.has(id),
  useEnvironmentSupportsServerBrowser: () => false,
}));

import { alternatePreviewRuntime, previewRuntimeFor } from "./previewRuntime";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;

afterEach(() => {
  state.desktop = false;
  state.primary = null;
  state.serverBrowser = new Set();
});

describe("previewRuntimeFor", () => {
  it("keeps a remote Aside tab on its environment even when Electron is available", () => {
    state.desktop = true;
    state.primary = local;
    state.serverBrowser = new Set([remote]);

    expect(previewRuntimeFor(remote, "aside")).toBe("server");
    expect(previewRuntimeFor(remote, "work")).toBeUndefined();
  });
});

describe("alternatePreviewRuntime", () => {
  it("keeps Aside tabs in their native browser instead of moving their profile to Electron", () => {
    state.desktop = true;

    expect(
      alternatePreviewRuntime(remote, local, true, { runtime: "server", profileId: "aside" }),
    ).toBeNull();
    expect(alternatePreviewRuntime(remote, local, true, { runtime: "server" })).toBe("desktop");
  });
});

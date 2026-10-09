import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => true }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => null } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  useEnvironmentSupportsServerBrowser: () => false,
}));

import { alternatePreviewRuntime } from "./previewRuntime";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;

describe("alternatePreviewRuntime", () => {
  it("keeps Aside tabs in their native browser instead of moving their profile to Electron", () => {
    expect(
      alternatePreviewRuntime(remote, local, true, { runtime: "server", profileId: "aside" }),
    ).toBeNull();
    expect(alternatePreviewRuntime(remote, local, true, { runtime: "server" })).toBe("desktop");
  });
});

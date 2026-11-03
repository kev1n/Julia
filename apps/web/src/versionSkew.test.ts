import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const branding = vi.hoisted(() => ({ APP_VERSION: "0.0.34" }));
vi.mock("./branding", () => branding);

import { APP_VERSION } from "./branding";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  manualServerUpdateCommand,
  resolveVersionMismatch,
} from "./versionSkew";

const MISMATCH_HINT =
  "Version mismatch. Try syncing the client and server to the same Julia version.";

describe("versionSkew", () => {
  it("updates only the proven npm prefix and safely quotes its path", () => {
    expect(manualServerUpdateCommand("0.0.45", { kind: "npm-global", prefix: "/opt/node" })).toBe(
      "npm install --global --prefix '/opt/node' t3@0.0.45",
    );
    expect(
      manualServerUpdateCommand("0.0.45", { kind: "npm-global", prefix: "/opt/maria's node" }),
    ).toBe("npm install --global --prefix '/opt/maria'\\''s node' t3@0.0.45");
  });
  beforeEach(() => {
    branding.APP_VERSION = "0.0.34";
  });

  it("returns a mismatch when the server is behind the client", () => {
    expect(resolveVersionMismatch("0.0.33")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "0.0.33",
      hint: MISMATCH_HINT,
    });
  });

  it("does not warn when the server is ahead of the client", () => {
    expect(resolveVersionMismatch("0.0.35")).toBeNull();
    expect(resolveVersionMismatch("9.9.9")).toBeNull();
  });

  it("does not warn when a nightly and a stable build share a core version", () => {
    expect(resolveVersionMismatch("0.0.34-nightly.20260818.1124")).toBeNull();

    branding.APP_VERSION = "0.0.34-nightly.20260818.1124";
    expect(resolveVersionMismatch("0.0.34")).toBeNull();
  });

  it.each(["0.0.34-nightly.20260823.1124", "0.0.34-nightly.20260824.1124"])(
    "warns when nightly server %s is behind a nightly client on the same release",
    (serverVersion) => {
      branding.APP_VERSION = "0.0.34-nightly.20260824.1125";

      expect(resolveVersionMismatch(serverVersion)).toEqual({
        clientVersion: "0.0.34-nightly.20260824.1125",
        serverVersion,
        hint: MISMATCH_HINT,
      });
    },
  );

  // regression: #7579 versions were compared as strings, not semver
  it("does not offer an update based on fork hash ordering", () => {
    branding.APP_VERSION = "0.0.46-nightly.20261007.2787+fork.dd65a77";
    expect(resolveVersionMismatch("0.0.46-nightly.20261007.2787+fork.9f0409f")).toBeNull();
    expect(resolveVersionMismatch("0.0.46-nightly.20261007.2787+fork.a45def3")).toBeNull();
  });

  it("orders fork updates by their prerelease revision, not their hash", () => {
    branding.APP_VERSION = "0.0.46-nightly.20261007.2787.fork.1791429000+fork.a45def3";
    expect(resolveVersionMismatch("0.0.46-nightly.20261007.2787+fork.dd65a77")).not.toBeNull();
    expect(
      resolveVersionMismatch("0.0.46-nightly.20261007.2787.fork.1791428999+fork.dd65a77"),
    ).not.toBeNull();
    expect(
      resolveVersionMismatch("0.0.46-nightly.20261007.2787.fork.1791429001+fork.9f0409f"),
    ).toBeNull();
  });

  it("treats a nightly server built past the client as ahead, not skew", () => {
    expect(resolveVersionMismatch("0.0.35-nightly.20260818.1124")).toBeNull();
  });

  it("still warns when a nightly client outruns the server by a release", () => {
    branding.APP_VERSION = "0.0.35-nightly.20260818.1124";

    expect(resolveVersionMismatch("0.0.34")).toEqual({
      clientVersion: "0.0.35-nightly.20260818.1124",
      serverVersion: "0.0.34",
      hint: MISMATCH_HINT,
    });
  });

  it("falls back to string inequality when a version is not semver", () => {
    expect(resolveVersionMismatch("dev")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "dev",
      hint: MISMATCH_HINT,
    });

    branding.APP_VERSION = "dev";
    expect(resolveVersionMismatch("dev")).toBeNull();
    expect(resolveVersionMismatch("0.0.34")).toMatchObject({ serverVersion: "0.0.34" });
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

    expect(isVersionMismatchDismissed(key)).toBe(false);

    dismissVersionMismatch(key);

    expect(isVersionMismatchDismissed(key)).toBe(true);
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: "9.9.10",
        }),
      ),
    ).toBe(false);
  });
});

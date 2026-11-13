import { describe, expect, it } from "vite-plus/test";

import {
  cloneFolderCandidates,
  enqueue,
  isMirrorCommand,
  type MirrorState,
} from "./projectMirror.ts";

describe("enqueue", () => {
  it("keeps one request per machine and repository, the latest winning", () => {
    const empty: MirrorState = { cursor: 0, sources: {}, deliveries: {} };
    const created = enqueue(empty, ["env-a", "env-b"], {
      action: "create",
      repoKey: "github.com/acme/app",
      remoteUrl: "https://github.com/acme/app.git",
      title: "app",
      createdAt: 1,
    });
    const deleted = enqueue(created, ["env-a"], {
      action: "delete",
      repoKey: "github.com/acme/app",
      createdAt: 2,
    });
    expect(Object.values(deleted.deliveries).map((d) => [d.environmentId, d.action])).toEqual([
      ["env-a", "delete"],
      ["env-b", "create"],
    ]);
  });
});

describe("cloneFolderCandidates", () => {
  it("names the folder as git clone would, for https and ssh remotes", () => {
    expect(cloneFolderCandidates("~", "https://github.com/acme/app.git").slice(0, 2)).toEqual([
      "~/app",
      "~/app-2",
    ]);
    expect(cloneFolderCandidates("/srv/code/", "git@github.com:acme/x")[0]).toBe("/srv/code/x");
  });
});

describe("isMirrorCommand", () => {
  it("tells this module's own commands from the user's, so they are never echoed", () => {
    expect(isMirrorCommand("fleet-mirror:create:p1")).toBe(true);
    expect(isMirrorCommand("project-clone-create:p1")).toBe(false);
    expect(isMirrorCommand(null)).toBe(false);
  });
});

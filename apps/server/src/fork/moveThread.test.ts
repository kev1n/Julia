// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MoveFailure, packBranch, refTips, takeBundle } from "./moveThread.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();

/** A source repository with a thread worktree, and a target clone that shares its history. */
function machines() {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "move-")));
  const source = NodePath.join(dir, "source");
  NodeFS.mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(source, "a.txt"), "one\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const target = NodePath.join(dir, "target");
  git(dir, "clone", "-q", source, target);
  const worktree = NodePath.join(dir, "wt");
  git(source, "worktree", "add", "-q", "-b", "t3/feature", worktree);
  NodeFS.writeFileSync(NodePath.join(worktree, "b.txt"), "committed\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "work");
  return { source, target, worktree };
}

describe("moving a thread's branch between machines", () => {
  it("carries committed, uncommitted and untracked work and only what the target lacks", async () => {
    const { target, worktree } = machines();
    NodeFS.writeFileSync(NodePath.join(worktree, "a.txt"), "edited\n");
    NodeFS.writeFileSync(NodePath.join(worktree, "new.txt"), "untracked\n");

    const packed = await packBranch({
      worktreePath: worktree,
      branch: "t3/feature",
      commitMessage: "WIP: move to build-mac",
      haves: await refTips(target),
    });
    expect(packed.bundle).not.toBeNull();
    // The base commit is the target's already, so it is a prerequisite, not content.
    expect(git(worktree, "status", "--porcelain")).toBe("");
    const result = await takeBundle(target, "t3/feature", packed);

    expect(result).toEqual({ branch: "t3/feature", commit: packed.head });
    expect(git(target, "show", `${packed.head}:a.txt`)).toBe("edited");
    expect(git(target, "show", `${packed.head}:new.txt`)).toBe("untracked");
    expect(git(target, "show", `${packed.head}:b.txt`)).toBe("committed");
    expect(git(target, "log", "-1", "--format=%s", packed.head)).toBe("WIP: move to build-mac");
    // Nothing on the target moved: the new worktree's branch is made by the launch.
    expect(git(target, "branch", "--list", "t3/feature")).toBe("");
  });

  it("sends nothing when the target already has the tip, and avoids a taken branch name", async () => {
    const { target, worktree } = machines();
    const first = await packBranch({
      worktreePath: worktree,
      branch: "t3/feature",
      commitMessage: "WIP",
      haves: await refTips(target),
    });
    await takeBundle(target, "t3/feature", first);
    git(target, "branch", "t3/feature", first.head);
    git(target, "branch", "t3/feature-2", first.head);

    const again = await packBranch({
      worktreePath: worktree,
      branch: "t3/feature",
      commitMessage: "WIP",
      haves: await refTips(target),
    });
    expect(again).toEqual({ branch: "t3/feature", head: first.head, bundle: null });
    expect(await takeBundle(target, "t3/feature", again)).toEqual({
      branch: "t3/feature-3",
      commit: first.head,
    });
  });

  it("packs the branch the agent switched the worktree to", async () => {
    const { target, worktree } = machines();
    git(worktree, "switch", "-q", "-c", "recheck");
    NodeFS.writeFileSync(NodePath.join(worktree, "c.txt"), "on recheck\n");

    const packed = await packBranch({
      worktreePath: worktree,
      branch: "t3/feature",
      commitMessage: "WIP",
      haves: await refTips(target),
    });
    expect(packed.branch).toBe("recheck");
    await takeBundle(target, packed.branch, packed);
    expect(git(target, "show", `${packed.head}:c.txt`)).toBe("on recheck");
  });

  it("refuses a project checkout, so a shared branch is never committed to", async () => {
    const { source } = machines();
    await expect(
      packBranch({ worktreePath: source, branch: "main", commitMessage: "WIP", haves: [] }),
    ).rejects.toBeInstanceOf(MoveFailure);
  });
});

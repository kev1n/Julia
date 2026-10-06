// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseNameStatus, parseStatusV2, scanCheckout } from "./gitScan.ts";

describe("parseStatusV2", () => {
  it("reads branch, staged/unstaged, renames, untracked and unmerged entries", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head t3/fix login",
      "1 M. N... 100644 100644 100644 h1 h2 server/staged.go",
      "1 .M N... 100644 100644 100644 h1 h2 docs/with space.md",
      "1 MM N... 100644 100644 100644 h1 h2 both.go",
      "2 R. N... 100644 100644 100644 h1 h2 R100 new/name.go",
      "old/name.go",
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.go",
      "? untracked.txt",
      "",
    ].join("\0");
    expect(parseStatusV2(output)).toEqual({
      head: "abc123",
      branch: "t3/fix login",
      changes: [
        { path: "server/staged.go", kind: "staged", change: "M" },
        { path: "docs/with space.md", kind: "unstaged", change: "M" },
        { path: "both.go", kind: "staged", change: "M" },
        { path: "both.go", kind: "unstaged", change: "M" },
        { path: "new/name.go", kind: "staged", change: "R", from: "old/name.go" },
        { path: "conflict.go", kind: "unstaged", change: "U" },
        { path: "untracked.txt", kind: "untracked", change: "A" },
      ],
    });
  });
});

describe("parseNameStatus", () => {
  it("reads committed changes including renames and deletes", () => {
    expect(
      parseNameStatus(["M", "a.go", "R087", "old.go", "new.go", "D", "gone.go", ""].join("\0")),
    ).toEqual([
      { path: "a.go", kind: "committed", change: "M" },
      { path: "new.go", kind: "committed", change: "R", from: "old.go" },
      { path: "gone.go", kind: "committed", change: "D" },
    ]);
  });
});

describe("scanCheckout", () => {
  it("measures committed work from the branch it is stacked on, plus local changes", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fleet-scan-"));
    const run = (cwd: string, ...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
    const write = (cwd: string, file: string, text: string) =>
      NodeFS.writeFileSync(NodePath.join(cwd, file), text);
    run(root, "init", "-q", "--bare", "origin.git");
    run(root, "clone", "-q", "origin.git", "work");
    const work = NodePath.join(root, "work");
    run(work, "config", "user.email", "t@example.com");
    run(work, "config", "user.name", "t");
    run(work, "checkout", "-q", "-b", "main");
    write(work, "base.txt", "1");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "base");
    run(work, "push", "-q", "origin", "main");
    run(work, "remote", "set-head", "origin", "main");
    run(work, "checkout", "-q", "-b", "stack");
    write(work, "stack.txt", "1");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "stack");
    run(work, "checkout", "-q", "-b", "top");
    write(work, "top.txt", "1");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "top");
    write(work, "base.txt", "2");
    write(work, "new.txt", "x");
    const scan = await scanCheckout(work);
    expect(scan.branch).toBe("top");
    expect(scan.base?.ref).toBe("stack");
    expect(scan.changes.map((change) => [change.path, change.kind])).toEqual([
      ["top.txt", "committed"],
      ["base.txt", "unstaged"],
      ["new.txt", "untracked"],
    ]);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
});

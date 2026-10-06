// @effect-diagnostics globalFetch:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork (Owner): the git half of moving a thread, machine to machine. The target asks the source
 * (fleet `move/pack`) to commit everything in the worktree and send a git bundle of what the target
 * lacks, then unbundles it under a free branch name. Nothing is pushed or fetched from GitHub.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import type { ForkMoveReceiveInput, ForkMoveReceiveResult } from "@t3tools/contracts";

import { fleetConfig, localSnapshot } from "./fleet/publisher.ts";
import { loadView } from "./fleet/view.ts";

export class MoveFailure extends Schema.TaggedError<MoveFailure>()("MoveFailure", {
  message: Schema.String,
}) {}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (cwd: string, args: ReadonlyArray<string>, input?: string): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", [...args], { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

const git = async (cwd: string, args: ReadonlyArray<string>, input?: string) => {
  const result = await run(cwd, args, input);
  if (result.code !== 0) {
    throw new MoveFailure({ message: `git ${args[0]} failed in ${cwd}: ${result.stderr.trim()}` });
  }
  return result.stdout.trim();
};

const tempFile = () =>
  NodePath.join(NodeOS.tmpdir(), `t3-fork-move-${NodeCrypto.randomUUID()}.bundle`);

export interface PackRequest {
  readonly worktreePath: string;
  readonly branch: string;
  readonly commitMessage: string;
  /** Commits the target already has; those this repository knows are left out of the bundle. */
  readonly haves: ReadonlyArray<string>;
}

/**
 * Source side. Refuses anything but a linked worktree on `branch`, so a shared
 * branch checked out in a project checkout is never committed to.
 * Returns the branch tip and the bundle, or null when the target already has the tip.
 */
export async function packBranch(
  request: PackRequest,
): Promise<{ readonly head: string; readonly bundle: Uint8Array | null }> {
  const cwd = request.worktreePath;
  const [gitDir, commonDir] = (
    await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
  ).split("\n");
  if (gitDir === commonDir) {
    throw new MoveFailure({
      message: `${cwd} is a project checkout, not a thread's own worktree.`,
    });
  }
  const current = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (current !== request.branch) {
    throw new MoveFailure({ message: `${cwd} is on ${current}, not ${request.branch}.` });
  }
  await git(cwd, ["add", "-A"]);
  if ((await run(cwd, ["diff", "--cached", "--quiet"])).code !== 0) {
    // A move must not be blocked by the project's commit hooks.
    await git(cwd, ["commit", "--no-verify", "-m", request.commitMessage]);
  }
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const known = (await git(cwd, ["cat-file", "--batch-check"], request.haves.join("\n") + "\n"))
    .split("\n")
    .filter((line) => / commit \d+$/.test(line))
    .map((line) => line.split(" ")[0]!);
  const file = tempFile();
  try {
    const created = await run(cwd, [
      "bundle",
      "create",
      file,
      `refs/heads/${request.branch}`,
      ...(known.length > 0 ? ["--not", ...known] : []),
    ]);
    if (created.code !== 0) {
      // Everything on the branch is already in the target's history.
      if (created.stderr.includes("empty bundle")) return { head, bundle: null };
      throw new MoveFailure({ message: `git bundle failed in ${cwd}: ${created.stderr.trim()}` });
    }
    return { head, bundle: new Uint8Array(await NodeFS.promises.readFile(file)) };
  } finally {
    await NodeFS.promises.rm(file, { force: true });
  }
}

/** Target side: fetch the branch from the source machine and make its commit available here. */
export async function receiveMove(input: ForkMoveReceiveInput): Promise<ForkMoveReceiveResult> {
  const config = fleetConfig();
  if (config === null)
    throw new MoveFailure({ message: "The fleet is not configured on this machine." });
  const view = await loadView(config, localSnapshot());
  const source = view.entries.find(
    (entry) => entry.snapshot.environmentId === input.sourceEnvironmentId,
  )?.snapshot;
  if (source === undefined) {
    throw new MoveFailure({
      message: `The source machine is not in the fleet index (hub ${view.hub}).`,
    });
  }
  const root = input.projectRoot;
  const pack: PackRequest = {
    worktreePath: input.sourceWorktreePath,
    branch: input.branch,
    commitMessage: input.commitMessage,
    haves: await refTips(root),
  };
  let response: Response;
  try {
    response = await fetch(`${source.baseUrl}/fork/fleet/move/pack`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
      body: JSON.stringify(pack),
    });
  } catch (cause) {
    throw new MoveFailure({
      message: `${source.label} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  if (!response.ok) {
    throw new MoveFailure({ message: `${source.label}: ${(await response.text()).slice(0, 500)}` });
  }
  const head = response.headers.get("x-fork-move-head") ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(head))
    throw new MoveFailure({ message: `${source.label}: no branch tip.` });
  return takeBundle(root, input.branch, {
    head,
    bundle: response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : null,
  });
}

/** Every commit a ref of this repository points at: what a bundle for it may leave out. */
export async function refTips(root: string): Promise<ReadonlyArray<string>> {
  const tips = await git(root, [
    "for-each-ref",
    "--format=%(objectname)",
    "refs/heads",
    "refs/remotes",
  ]);
  return [...new Set(tips.split("\n").filter((line) => line !== ""))];
}

/** Unbundle into `root` (no ref changes) and choose the branch name for the new worktree. */
export async function takeBundle(
  root: string,
  branch: string,
  packed: { readonly head: string; readonly bundle: Uint8Array | null },
): Promise<ForkMoveReceiveResult> {
  if (packed.bundle !== null) {
    const file = tempFile();
    try {
      await NodeFS.promises.writeFile(file, packed.bundle);
      await git(root, ["bundle", "unbundle", file]);
    } finally {
      await NodeFS.promises.rm(file, { force: true });
    }
  }
  await git(root, ["cat-file", "-e", `${packed.head}^{commit}`]);
  return { branch: await freeBranchName(root, branch), commit: packed.head };
}

async function freeBranchName(root: string, branch: string): Promise<string> {
  const taken = async (name: string) =>
    (await run(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])).code === 0;
  if (!(await taken(branch))) return branch;
  for (let suffix = 2; ; suffix += 1) {
    if (!(await taken(`${branch}-${suffix}`))) return `${branch}-${suffix}`;
  }
}

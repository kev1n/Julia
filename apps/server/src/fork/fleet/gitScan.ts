// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork (Owner): what a checkout has changed, from git. Committed changes are measured from the
 * merge-base with the default remote branch or a closer local branch it is stacked on; the rest
 * comes from `git status`. The base is cached per HEAD and branch tips (about 36 ms per scan).
 */
import * as NodeChildProcess from "node:child_process";

import { HEARTBEAT_MS } from "./config.ts";
import type { FleetPathChange } from "./model.ts";

const git = (cwd: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        // A scan older than one heartbeat is superseded; a stuck git must not stall the publisher.
        timeout: HEARTBEAT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

const CHANGE: Record<string, FleetPathChange["change"]> = {
  A: "A",
  M: "M",
  D: "D",
  R: "R",
  C: "A",
  T: "T",
  U: "U",
};

/** Parse `git status --porcelain=v2 -z --branch --untracked-files=all`. */
export function parseStatusV2(output: string): {
  readonly head: string | null;
  readonly branch: string | null;
  readonly changes: ReadonlyArray<FleetPathChange>;
} {
  const fields = output.split("\0");
  let head: string | null = null;
  let branch: string | null = null;
  const changes: FleetPathChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const line = fields[index]!;
    if (line === "") continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length);
      head = oid === "(initial)" ? null : oid;
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length);
      branch = name === "(detached)" ? null : name;
      continue;
    }
    if (line.startsWith("? ")) {
      changes.push({ path: line.slice(2), kind: "untracked", change: "A" });
      continue;
    }
    const kind = line[0];
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    // Field counts per porcelain v2: ordinary 9, rename 10, unmerged 11 (path last).
    const pathFieldIndex = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    const path = parts.slice(pathFieldIndex).join(" ");
    const from = kind === "2" ? fields[++index] : undefined;
    if (kind === "u") {
      changes.push({ path, kind: "unstaged", change: "U" });
      continue;
    }
    const staged = xy[0] ?? ".";
    const unstaged = xy[1] ?? ".";
    if (staged !== ".") {
      changes.push({
        path,
        kind: "staged",
        change: CHANGE[staged] ?? "M",
        ...(staged === "R" && from !== undefined ? { from } : {}),
      });
    }
    if (unstaged !== ".") {
      changes.push({ path, kind: "unstaged", change: CHANGE[unstaged] ?? "M" });
    }
  }
  return { head, branch, changes };
}

/** Parse `git diff --name-status -z -M`. */
export function parseNameStatus(output: string): ReadonlyArray<FleetPathChange> {
  const fields = output.split("\0").filter((field) => field !== "");
  const changes: FleetPathChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]!;
    const letter = status[0] ?? "M";
    if (letter === "R" || letter === "C") {
      const from = fields[++index]!;
      const path = fields[++index]!;
      changes.push(
        letter === "R"
          ? { path, kind: "committed", change: "R", from }
          : { path, kind: "committed", change: "A" },
      );
    } else {
      changes.push({ path: fields[++index]!, kind: "committed", change: CHANGE[letter] ?? "M" });
    }
  }
  return changes;
}

export interface CheckoutScan {
  readonly head: string | null;
  readonly branch: string | null;
  readonly base: { readonly ref: string; readonly sha: string } | null;
  readonly changes: ReadonlyArray<FleetPathChange>;
}

// One entry per checkout: the base for its current HEAD and branch tips.
const baseCache = new Map<
  string,
  { readonly key: string; readonly base: { readonly ref: string; readonly sha: string } | null }
>();

async function defaultRemoteRef(cwd: string): Promise<string | null> {
  const symbolic = await git(cwd, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).catch(
    () => "",
  );
  if (symbolic.trim() !== "") return symbolic.trim();
  for (const candidate of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    const exists = await git(cwd, ["rev-parse", "-q", "--verify", candidate]).catch(() => "");
    if (exists.trim() !== "") return candidate;
  }
  return null;
}

async function resolveBase(
  cwd: string,
  head: string,
  branch: string | null,
): Promise<{ readonly ref: string; readonly sha: string } | null> {
  const defaultRef = await defaultRemoteRef(cwd);
  const tips = (await git(cwd, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"]))
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith(` refs/heads/${branch ?? ""}`));
  const cacheKey = `${head}|${defaultRef}|${tips.join(",")}`;
  const cached = baseCache.get(cwd);
  if (cached?.key === cacheKey) return cached.base;
  const candidates = [
    ...(defaultRef === null ? [] : [{ ref: defaultRef, isDefault: true }]),
    ...tips.map((line) => ({ ref: line.slice(line.indexOf(" ") + 1), isDefault: false })),
  ];
  let best: { ref: string; sha: string; distance: number; isDefault: boolean } | null = null;
  for (const candidate of candidates) {
    const sha = (await git(cwd, ["merge-base", head, candidate.ref]).catch(() => "")).trim();
    if (sha === "") continue;
    // A branch that already contains HEAD is a descendant or a twin, not a base.
    if (sha === head && !candidate.isDefault) continue;
    const distance = Number(
      (await git(cwd, ["rev-list", "--count", `${sha}..${head}`]).catch(() => "")).trim(),
    );
    if (!Number.isFinite(distance)) continue;
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && candidate.isDefault && !best.isDefault)
    ) {
      best = { ref: candidate.ref, sha, distance, isDefault: candidate.isDefault };
    }
  }
  const base =
    best === null ? null : { ref: best.ref.replace(/^refs\/(heads|remotes)\//, ""), sha: best.sha };
  baseCache.set(cwd, { key: cacheKey, base });
  return base;
}

export async function scanCheckout(cwd: string): Promise<CheckoutScan> {
  const status = parseStatusV2(
    await git(cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]),
  );
  if (status.head === null) return { ...status, base: null };
  const base = await resolveBase(cwd, status.head, status.branch);
  const committed =
    base === null || base.sha === status.head
      ? []
      : parseNameStatus(
          await git(cwd, ["diff", "--name-status", "-z", "-M", base.sha, status.head]),
        );
  return {
    head: status.head,
    branch: status.branch,
    base,
    changes: [...committed, ...status.changes],
  };
}

/** Drop cached bases for checkouts that no longer exist. */
export function forgetCheckoutsExcept(paths: ReadonlySet<string>): void {
  for (const path of baseCache.keys()) if (!paths.has(path)) baseCache.delete(path);
}

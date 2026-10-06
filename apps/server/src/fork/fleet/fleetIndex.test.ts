import { describe, expect, it } from "vite-plus/test";

import { acmePathMeaning } from "./acmePaths.ts";
import { coverageOf, findOverlaps, matchKeys, mergeSnapshot } from "./fleetIndex.ts";
import type { FleetCheckout, FleetSnapshot, FleetThread } from "./model.ts";

const REPO = "github.com/example-com/acme";

function thread(env: string, id: string, overrides: Partial<FleetThread> = {}): FleetThread {
  return {
    environmentId: env,
    threadId: id,
    title: id,
    projectId: "p",
    repoKey: REPO,
    branch: `t3/${id}`,
    checkoutKey: `${env}:/wt/${id}`,
    lifecycle: "running",
    runtimeMode: "full-access",
    providerInstanceId: "claudeAgent",
    model: "claude-opus-5-5",
    lastActivityAt: 1,
    intents: [],
    intentsAt: null,
    ...overrides,
  };
}

function checkout(
  env: string,
  id: string,
  paths: Array<[string, FleetCheckout["changes"][number]["kind"]]>,
): FleetCheckout {
  return {
    key: `${env}:/wt/${id}`,
    path: `/wt/${id}`,
    repoKey: REPO,
    branch: `t3/${id}`,
    head: "h",
    base: { ref: "origin/main", sha: "b" },
    changes: paths.map(([path, kind]) => ({ path, kind, change: "M" })),
    scannedAt: 1,
  };
}

function snapshot(env: string, overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    environmentId: env,
    label: env,
    baseUrl: `https://${env}`,
    incarnation: "i1",
    seq: 1,
    complete: true,
    lastScanAt: 1,
    threads: [],
    checkouts: [],
    ...overrides,
  };
}

describe("mergeSnapshot", () => {
  it("ignores an older snapshot from the same incarnation", () => {
    const first = mergeSnapshot(undefined, snapshot("mac-a", { seq: 5 }), 10);
    if (!first.accepted) throw new Error("first rejected");
    expect(mergeSnapshot(first.entry, snapshot("mac-a", { seq: 4 }), 11)).toMatchObject({
      accepted: false,
    });
    // A restarted server (new incarnation) starts its sequence again.
    expect(
      mergeSnapshot(first.entry, snapshot("mac-a", { seq: 1, incarnation: "i2" }), 11),
    ).toMatchObject({ accepted: true });
  });

  it("a complete snapshot drops threads and checkouts it no longer lists (deleted thread, removed worktree)", () => {
    const first = mergeSnapshot(
      undefined,
      snapshot("mac-a", {
        threads: [thread("mac-a", "a"), thread("mac-a", "b")],
        checkouts: [checkout("mac-a", "a", [["x", "unstaged"]])],
      }),
      10,
    );
    if (!first.accepted) throw new Error();
    const next = mergeSnapshot(
      first.entry,
      snapshot("mac-a", { seq: 2, threads: [thread("mac-a", "a")] }),
      11,
    );
    if (!next.accepted) throw new Error();
    expect(next.entry.snapshot.threads.map((t) => t.threadId)).toEqual(["a"]);
    expect(next.entry.snapshot.checkouts).toEqual([]);
  });

  it("a partial snapshot never erases", () => {
    const first = mergeSnapshot(
      undefined,
      snapshot("mac-a", {
        threads: [thread("mac-a", "a"), thread("mac-a", "b")],
        checkouts: [checkout("mac-a", "a", [["x", "unstaged"]])],
      }),
      10,
    );
    if (!first.accepted) throw new Error();
    const next = mergeSnapshot(
      first.entry,
      snapshot("mac-a", {
        seq: 2,
        complete: false,
        threads: [thread("mac-a", "a", { lifecycle: "idle" })],
      }),
      11,
    );
    if (!next.accepted) throw new Error();
    expect(next.entry.snapshot.threads.map((t) => [t.threadId, t.lifecycle])).toEqual([
      ["a", "idle"],
      ["b", "running"],
    ]);
    expect(next.entry.snapshot.checkouts).toHaveLength(1);
  });

  it("a failed scan keeps the last good evidence", () => {
    const first = mergeSnapshot(
      undefined,
      snapshot("mac-a", { checkouts: [checkout("mac-a", "a", [["x", "staged"]])] }),
      10,
    );
    if (!first.accepted) throw new Error();
    const failed = { ...checkout("mac-a", "a", []), scannedAt: null, scanError: "git died" };
    const next = mergeSnapshot(first.entry, snapshot("mac-a", { seq: 2, checkouts: [failed] }), 11);
    if (!next.accepted) throw new Error();
    expect(next.entry.snapshot.checkouts[0]).toMatchObject({ scanError: "git died", scannedAt: 1 });
    expect(next.entry.snapshot.checkouts[0]!.changes.map((c) => c.path)).toEqual(["x"]);
  });
});

describe("coverageOf", () => {
  it("marks an environment stale after its heartbeat is too old, and keeps its records", () => {
    const entries = [
      { snapshot: snapshot("mac-a", { threads: [thread("mac-a", "a")] }), receivedAt: 100 },
      { snapshot: snapshot("build-mac", { threads: [thread("build-mac", "b")] }), receivedAt: 10 },
    ];
    expect(
      coverageOf(entries, 120, 30).map((row) => [row.environmentId, row.status, row.threadCount]),
    ).toEqual([
      ["mac-a", "fresh", 1],
      ["build-mac", "stale", 1],
    ]);
  });
});

describe("findOverlaps", () => {
  const me = thread("mac-a", "a");
  const myCheckout = checkout("mac-a", "a", [["server/x.go", "unstaged"]]);
  const entry = (snap: FleetSnapshot, receivedAt = 100) => ({ snapshot: snap, receivedAt });

  it("reports an exact-path write/write between two machines with each side's evidence", () => {
    const other = entry(
      snapshot("build-mac", {
        threads: [thread("build-mac", "b")],
        checkouts: [
          checkout("build-mac", "b", [
            ["server/x.go", "committed"],
            ["other.go", "untracked"],
          ]),
        ],
      }),
    );
    const [overlap] = findOverlaps({
      me,
      myCheckout,
      entries: [entry(snapshot("mac-a", { threads: [me], checkouts: [myCheckout] })), other],
      now: 110,
      staleAfterMs: 30,
    });
    expect(overlap).toMatchObject({
      sharedCheckout: false,
      stale: false,
      environmentLabel: "build-mac",
    });
    expect(overlap!.paths).toEqual([
      {
        path: "server/x.go",
        conflict: "write/write",
        mine: [{ source: "observed", kind: "unstaged", change: "M" }],
        theirs: [{ source: "observed", kind: "committed", change: "M" }],
      },
    ]);
  });

  it("matches a declared directory key and grades declared reads", () => {
    const other = entry(
      snapshot("build-mac", {
        threads: [thread("build-mac", "b", { intents: [{ key: "server/", access: "read" }] })],
      }),
    );
    const [overlap] = findOverlaps({
      me,
      myCheckout,
      entries: [other],
      now: 110,
      staleAfterMs: 30,
    });
    expect(overlap!.paths[0]).toMatchObject({ path: "server/x.go", conflict: "read/write" });
  });

  it("leaves out settled and archived threads, other repositories, and itself", () => {
    const others = entry(
      snapshot("build-mac", {
        threads: [
          thread("build-mac", "s", { lifecycle: "settled" }),
          thread("build-mac", "z", { lifecycle: "archived" }),
          thread("build-mac", "r", { repoKey: "github.com/x/y" }),
        ],
        checkouts: ["s", "z", "r"].map((id) =>
          checkout("build-mac", id, [["server/x.go", "unstaged"]]),
        ),
      }),
    );
    const self = entry(snapshot("mac-a", { threads: [me], checkouts: [myCheckout] }));
    expect(
      findOverlaps({ me, myCheckout, entries: [self, others], now: 110, staleAfterMs: 30 }),
    ).toEqual([]);
  });

  it("groups threads sharing one checkout and flags stale machines", () => {
    const twin = thread("mac-a", "twin", { checkoutKey: me.checkoutKey });
    const stale = entry(snapshot("mac-a", { threads: [me, twin], checkouts: [myCheckout] }), 10);
    const [overlap] = findOverlaps({
      me,
      myCheckout,
      entries: [stale],
      now: 110,
      staleAfterMs: 30,
    });
    expect(overlap).toMatchObject({ sharedCheckout: true, stale: true });
  });

  it("counts both sides of a rename", () => {
    const renamed: FleetCheckout = {
      ...checkout("build-mac", "b", []),
      changes: [{ path: "new.go", kind: "staged", change: "R", from: "server/x.go" }],
    };
    const other = entry(
      snapshot("build-mac", { threads: [thread("build-mac", "b")], checkouts: [renamed] }),
    );
    expect(
      findOverlaps({ me, myCheckout, entries: [other], now: 110, staleAfterMs: 30 })[0]!.paths[0]!
        .path,
    ).toBe("server/x.go");
  });
});

describe("matchKeys and Acme meaning", () => {
  it("matches exact paths and directory keys only", () => {
    expect(matchKeys("a/b.go", "a/b.go")).toBe("a/b.go");
    expect(matchKeys("a/", "a/b.go")).toBe("a/b.go");
    expect(matchKeys("a/b", "a/bc")).toBeNull();
  });

  it("names SKUs from manifests and schemas, leaves the rest unknown", () => {
    expect(
      acmePathMeaning(REPO, "server/internal/registry/assets/manifests/amazon.search.json"),
    ).toEqual({ sku: "amazon.search" });
    expect(
      acmePathMeaning(REPO, "server/internal/registry/assets/schemas/amazon.search.output.json"),
    ).toEqual({ sku: "amazon.search" });
    expect(acmePathMeaning(REPO, "server/internal/deepline/client.go")).toEqual({
      provider: "deepline",
    });
    expect(acmePathMeaning(REPO, "server/internal/routing/x.go")).toBeNull();
    expect(
      acmePathMeaning(
        "github.com/pingdotgg/t3code",
        "server/internal/registry/assets/manifests/a.json",
      ),
    ).toBeNull();
  });
});

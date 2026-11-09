// Runs one agent chat on this Mac's T3 Code server and waits for it to finish,
// so the sync's auto-fix shows up in the app like any other thread.
//   node fork/scripts/autofix-thread.mjs <repo-root> <worktree> <title> <prompt-file> <limit-seconds>
//   node fork/scripts/autofix-thread.mjs settle
// Finds (or adds) the T3 project for <repo-root>, launches a thread bound to the
// existing git worktree <worktree> with full access on the account
// `autofixModelSelection` picks from the "Fork sync auto-fix models" setting,
// and blocks until its run ends or <limit-seconds> pass;
// then it stops the chat's turn (as the Stop button does) and reports
// status "timed out". Prints one JSON line: {"environmentId","threadId","status"}
// `settle` settles every finished auto-fix chat, so the thread list holds at most
// the one from the latest failed sync: the sync runs it before launching a new
// chat and after accepting one. A chat someone pinned or reopened is left alone.
// It speaks the server's WebSocket RPC (Effect RPC JSON) with a short-lived
// session from `t3 auth session issue`, revoked on exit.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { chatWaiter, ended } from "./autofix-wait.mjs";

const [repoRoot, worktree, title, promptFile, limitSeconds] = process.argv.slice(2);
const settling = repoRoot === "settle";
if (!limitSeconds && !settling)
  throw new Error(
    "usage: autofix-thread.mjs <repo-root> <worktree> <title> <prompt-file> <limit-seconds> | settle",
  );
const server = "http://127.0.0.1:3773";
const t3 = `${process.env.HOME}/.local/bin/t3`;

// The daily sync starts a fresh run every 24 h, so a session never needs to
// outlive one day; it is revoked when we exit.
const session = JSON.parse(
  execFileSync(t3, [
    "auth",
    "session",
    "issue",
    "--ttl",
    "24h",
    "--label",
    "fork-autofix",
    "--json",
  ]),
);
const revoke = () => {
  try {
    execFileSync(t3, ["auth", "session", "revoke", session.sessionId], { stdio: "ignore" });
  } catch {}
};
process.on("exit", revoke);

async function connect() {
  const res = await fetch(`${server}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new Error(`websocket ticket: HTTP ${res.status}`);
  const { ticket } = await res.json();
  const ws = new WebSocket(
    `${server.replace("http", "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`,
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("websocket connect failed"));
  });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
    const handler = pending.get(msg.requestId);
    if (!handler) return;
    if (msg._tag === "Chunk") {
      ws.send(JSON.stringify({ _tag: "Ack", requestId: msg.requestId }));
      for (const value of msg.values) handler.chunk?.(value);
    } else if (msg._tag === "Exit") {
      pending.delete(msg.requestId);
      if (msg.exit._tag === "Success") handler.resolve(msg.exit.value);
      else handler.reject(new Error(`${handler.tag} failed: ${JSON.stringify(msg.exit.cause)}`));
    }
  };
  const closed = new Promise((resolve) => (ws.onclose = resolve));
  const call = (tag, payload, chunk) =>
    new Promise((resolve, reject) => {
      const id = String(++next);
      pending.set(id, { tag, resolve, reject, chunk });
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  return { ws, call, closed };
}

// The first snapshot of the shell stream carries the project and thread lists.
async function snapshot(conn) {
  return new Promise((resolve, reject) => {
    conn
      .call("orchestration.subscribeShell", {}, (item) => {
        if (item.kind === "snapshot") resolve(item.snapshot);
      })
      .catch(reject);
  });
}

if (settling) {
  const conn = await connect();
  const stale = (await snapshot(conn)).threads.filter(
    (thread) =>
      thread.title.startsWith("Fork sync auto-fix:") &&
      !thread.settledAt &&
      !thread.archivedAt &&
      !thread.deletedAt &&
      !thread.pinnedAt &&
      thread.settledOverride !== "active" &&
      !thread.activeRunId &&
      ended.has(thread.status),
  );
  for (const thread of stale) {
    await conn.call("orchestration.dispatchCommand", {
      type: "thread.settle",
      commandId: randomUUID(),
      threadId: thread.id,
    });
  }
  console.error(`autofix: settled ${stale.length} finished auto-fix chat(s)`);
  conn.ws.close();
  process.exit(0);
}

const { autofixModelSelection } = await import("../../apps/server/src/fork/autofixAccount.ts");
const { DEFAULT_SERVER_SETTINGS } = await import("../../packages/contracts/src/settings.ts");
const root = realpathSync(repoRoot);
const environment = await (await fetch(`${server}/.well-known/t3/environment`)).json();
let conn = await connect();
let project = (await snapshot(conn)).projects.find((p) => p.workspaceRoot === root);
if (!project) {
  project = await conn.call("projects.mutate", {
    type: "project.create",
    commandId: randomUUID(),
    projectId: randomUUID(),
    title: basename(root),
    workspaceRoot: root,
  });
}
conn.ws.close();
conn = await connect();

const { providers, settings } = await conn.call("server.getConfig", {});
const modelSelection = autofixModelSelection(
  // A server older than the setting (the release a failed sync leaves running)
  // does not report it; use its default then.
  settings.syncAutofixModelSelections ?? DEFAULT_SERVER_SETTINGS.syncAutofixModelSelections,
  providers,
  Date.now(),
);
if (!modelSelection) throw new Error("the Fork sync auto-fix models setting is empty");
console.error(`autofix: running on ${modelSelection.instanceId} (${modelSelection.model})`);

const launch = await conn.call("orchestration.launchThread", {
  commandId: randomUUID(),
  creationSource: "server",
  projectId: project.id,
  title,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "existing_worktree", worktreePath: worktree },
  initialMessage: { text: readFileSync(promptFile, "utf8"), attachments: [] },
});
const threadId = launch.threadId;
console.error(`autofix: thread ${threadId} launched on ${environment.label}`);

// Follow the thread on the shell stream; reconnect if the socket drops (a
// server restart, say) and read the state again from the fresh snapshot.
const done = chatWaiter();
let current = conn;
let runId = null;
const status = await new Promise((resolve, reject) => {
  setTimeout(
    () => {
      if (runId === null) return resolve("timed out");
      current
        .call("orchestration.dispatchCommand", {
          type: "run.interrupt",
          commandId: randomUUID(),
          threadId,
          runId,
          reason: "Fork sync auto-fix time limit reached",
          holdQueue: true,
        })
        .then(() => resolve("timed out"), reject);
    },
    Number(limitSeconds) * 1000,
  );
  const watch = (c) => {
    current = c;
    const check = (thread) => {
      if (!thread || thread.id !== threadId) return;
      runId = thread.activeRunId ?? thread.latestRunId ?? runId;
      const status = done(thread);
      if (status) resolve(status);
    };
    c.call("orchestration.subscribeShell", {}, (item) => {
      if (item.kind === "snapshot") item.snapshot.threads.forEach(check);
      if (item.kind === "thread.updated") check(item.thread);
      if (item.kind === "thread.removed" && item.threadId === threadId) resolve("deleted");
    }).catch(reject);
    c.closed.then(async () => {
      for (;;) {
        try {
          return watch(await connect());
        } catch {
          await new Promise((r) => setTimeout(r, 5000)); // server restarting
        }
      }
    });
  };
  watch(conn);
});
current.ws.onclose = null;
current.ws.close();
console.log(JSON.stringify({ environmentId: environment.environmentId, threadId, status }));
process.exit(0);

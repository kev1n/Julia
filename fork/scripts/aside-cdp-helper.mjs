// Launches Aside with its Chrome DevTools Protocol on a private pipe and lends that pipe to
// one T3 server at a time over a Unix socket only this user can open. launchd keeps it
// running, so T3 restarts never quit Aside (which would relock 1Password on the minis).
//
// Frames on both sides are NUL-terminated CDP JSON. The helper never forwards Browser.close,
// and when a client leaves it undoes what that client left attached, so the next one sees
// every tab and Aside runs as if nothing had connected.
//
// Usage: node aside-cdp-helper.mjs [socket path]   (default ~/.t3-aside/cdp.sock)
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** Splits a NUL-terminated stream into messages. */
export const frames = (onMessage) => {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (message) onMessage(message);
    }
  };
};

/** Private, single-client transport. Tests provide fake pipes, never a real browser. */
export const lendAsidePipe = (toAside, fromAside, log = () => {}) => {
  fromAside.setEncoding("utf8");
  let reserved = null;
  let client = null;
  let cleaning = Promise.resolve();
  let ownId = 1_000_000_000;
  const own = new Map();
  const sessions = new Set();
  const requests = new Set();
  const requestKey = (message) => JSON.stringify([message.sessionId ?? null, message.id]);
  const parse = (raw) => {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      log("ignored malformed CDP frame");
      return null;
    }
  };

  const sendOwn = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++ownId;
      const timer = setTimeout(
        () => own.delete(id) && resolve({ error: { message: "timeout" } }),
        5_000,
      );
      own.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      toAside.write(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0",
      );
    });

  fromAside.on(
    "data",
    frames((raw) => {
      const message = parse(raw);
      if (!message) return;
      if (message.id !== undefined && own.has(message.id)) {
        own.get(message.id)(message);
        own.delete(message.id);
        return;
      }
      if (message.method === "Target.attachedToTarget" && message.params?.sessionId)
        sessions.add(message.params.sessionId);
      if (message.method === "Target.detachedFromTarget")
        sessions.delete(message.params?.sessionId);
      if (message.result?.sessionId) sessions.add(message.result.sessionId);
      if (message.id !== undefined && !requests.delete(requestKey(message))) return;
      if (client && !client.destroyed) client.write(raw + "\0");
    }),
  );

  /** Leaves Aside as a client found it: nothing attached, paused or redirected. */
  const cleanUp = async () => {
    await sendOwn("Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await sendOwn("Target.setDiscoverTargets", { discover: false });
    await sendOwn("Browser.setDownloadBehavior", { behavior: "default" });
    const left = [...sessions];
    for (const sessionId of left) {
      await sendOwn("Runtime.runIfWaitingForDebugger", {}, sessionId);
      await sendOwn("Target.detachFromTarget", { sessionId });
      sessions.delete(sessionId);
    }
    log(`cleaned up after client; detached ${left.length} sessions`);
  };

  const server = NodeNet.createServer((socket) => {
    if (reserved) {
      socket.destroy();
      return;
    }
    reserved = socket;
    socket.pause();
    socket.setEncoding("utf8");
    log("client connected");
    void cleaning.then(() => {
      if (socket.destroyed || reserved !== socket) return;
      client = socket;
      socket.on(
        "data",
        frames((raw) => {
          const message = parse(raw);
          if (!message) return;
          // Never let a client quit the real browser.
          if (message.method === "Browser.close") {
            const reply = { id: message.id, result: {} };
            if (message.sessionId) reply.sessionId = message.sessionId;
            socket.write(JSON.stringify(reply) + "\0");
            return;
          }
          if (message.id !== undefined) requests.add(requestKey(message));
          toAside.write(raw + "\0");
        }),
      );
      socket.resume();
    });
    const gone = () => {
      if (reserved !== socket) return;
      reserved = null;
      if (client !== socket) return;
      client = null;
      requests.clear();
      cleaning = cleaning.then(cleanUp).catch((cause) => log("cleanup failed", cause));
    };
    socket.on("close", gone);
    socket.on("error", gone);
  });
  return server;
};

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const ASIDE = "/Applications/Aside.app/Contents/MacOS/Aside";
  const socketPath = process.argv[2] ?? NodePath.join(NodeOS.homedir(), ".t3-aside", "cdp.sock");
  const log = (...parts) => console.log(new Date().toISOString(), ...parts);

  NodeFS.mkdirSync(NodePath.dirname(socketPath), { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(NodePath.dirname(socketPath), 0o700);
  NodeFS.rmSync(socketPath, { force: true });

  const aside = NodeChildProcess.spawn(
    ASIDE,
    [
      "--remote-debugging-pipe",
      "--disable-blink-features=AutomationControlled",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    },
  );
  // Aside going away ends the helper. launchd starts both again after a crash, but not
  // after Aside was quit on purpose (a clean exit).
  aside.on("exit", (code, signal) => {
    log("Aside exited", code, signal);
    NodeFS.rmSync(socketPath, { force: true });
    process.exit(code === 0 ? 0 : 1);
  });
  const toAside = aside.stdio[3];
  const fromAside = aside.stdio[4];
  // Decoding per stream keeps a character split across chunks intact.
  fromAside.setEncoding("utf8");

  const server = lendAsidePipe(toAside, fromAside, log);
  server.listen(socketPath, () => {
    NodeFS.chmodSync(socketPath, 0o600);
    log("listening on", socketPath, "Aside pid", aside.pid);
  });
}

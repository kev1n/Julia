import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeTest from "node:test";
import { frames, lendAsidePipe } from "./aside-cdp-helper.mjs";

const fixture = async (t, onOwn) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aside-pipe-test-"));
  const socketPath = NodePath.join(directory, "cdp.sock");
  const toAside = new NodeStream.PassThrough();
  const fromAside = new NodeStream.PassThrough();
  const events = new NodeEvents.EventEmitter();
  const commands = [];
  const send = (message) => fromAside.write(JSON.stringify(message) + "\0");
  toAside.setEncoding("utf8");
  toAside.on(
    "data",
    frames((raw) => {
      const command = JSON.parse(raw);
      commands.push(command);
      if (command.id >= 1_000_000_000) {
        const reply = () => send({ id: command.id, result: {} });
        if (onOwn) onOwn(command, reply);
        else reply();
      } else {
        send({
          id: command.id,
          result: command.method === "Target.attachToTarget" ? { sessionId: "owned" } : {},
        });
      }
    }),
  );
  const server = lendAsidePipe(toAside, fromAside, (message) => {
    if (message.startsWith("cleaned up")) events.emit("cleaned");
  });
  server.listen(socketPath);
  await NodeEvents.once(server, "listening");
  const sockets = [];
  const connect = async () => {
    const socket = NodeNet.createConnection(socketPath);
    sockets.push(socket);
    const received = [];
    const messages = new NodeEvents.EventEmitter();
    socket.setEncoding("utf8");
    socket.on(
      "data",
      frames((raw) => {
        const message = JSON.parse(raw);
        received.push(message);
        messages.emit("message", message);
      }),
    );
    await NodeEvents.once(socket, "connect");
    return { socket, received, messages };
  };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  return { connect, commands, events, fromAside, send };
};

const request = async (client, message) => {
  const response = NodeEvents.once(client.messages, "message");
  client.socket.write(JSON.stringify(message) + "\0");
  return (await response)[0];
};

NodeTest.test(
  "blocks Browser.close, rejects a second client, and ignores malformed frames",
  { timeout: 5000 },
  async (t) => {
    const helper = await fixture(t);
    const client = await helper.connect();
    NodeAssert.deepEqual(await request(client, { id: 1, method: "Browser.close" }), {
      id: 1,
      result: {},
    });
    NodeAssert.equal(helper.commands.length, 0);
    const second = await helper.connect();
    await NodeEvents.once(second.socket, "close");
    helper.fromAside.write("not json\0");
    client.socket.write("not json\0");
    NodeAssert.equal((await request(client, { id: 2, method: "Runtime.evaluate" })).id, 2);
  },
);

NodeTest.test(
  "detaches sessions and restores native downloads on disconnect",
  { timeout: 5000 },
  async (t) => {
    const helper = await fixture(t);
    const client = await helper.connect();
    await request(client, { id: 1, method: "Target.attachToTarget" });
    const cleaned = NodeEvents.once(helper.events, "cleaned");
    client.socket.destroy();
    await cleaned;
    NodeAssert.deepEqual(
      helper.commands.slice(1).map((command) => command.method),
      [
        "Target.setAutoAttach",
        "Target.setDiscoverTargets",
        "Browser.setDownloadBehavior",
        "Runtime.runIfWaitingForDebugger",
        "Target.detachFromTarget",
      ],
    );
    NodeAssert.deepEqual(helper.commands[3].params, { behavior: "default" });
    NodeAssert.deepEqual(helper.commands[5].params, { sessionId: "owned" });
  },
);

NodeTest.test(
  "new clients wait for cleanup and never receive old responses",
  { timeout: 5000 },
  async (t) => {
    const cleanupStarted = Promise.withResolvers();
    let release;
    const helper = await fixture(t, (command, reply) => {
      if (!release) {
        release = reply;
        cleanupStarted.resolve();
      } else reply();
    });
    const first = await helper.connect();
    await request(first, { id: 1, method: "Runtime.evaluate" });
    first.socket.destroy();
    await cleanupStarted.promise;
    const next = await helper.connect();
    const response = NodeEvents.once(next.messages, "message");
    next.socket.write(JSON.stringify({ id: 1, method: "Runtime.evaluate" }) + "\0");
    helper.send({ id: 1, result: { stale: true } });
    helper.send({ method: "Target.targetCreated", params: { stale: true } });
    release();
    NodeAssert.deepEqual((await response)[0], { id: 1, result: {} });
    NodeAssert.deepEqual(next.received, [{ id: 1, result: {} }]);
  },
);

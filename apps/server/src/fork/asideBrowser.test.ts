// @effect-diagnostics nodeBuiltinImport:off - Drives the bridge with a fake helper socket.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ASIDE_UNAVAILABLE_MESSAGE,
  AsideUnavailableError,
  openAsideEndpoint,
} from "./asideBrowser.ts";

const fakeHelper = async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aside-"));
  const socketPath = NodePath.join(dir, "cdp.sock");
  const received: Array<string> = [];
  const clients: Array<NodeNet.Socket> = [];
  const connected = Promise.withResolvers<NodeNet.Socket>();
  const message = Promise.withResolvers<string>();
  const server = NodeNet.createServer((socket) => {
    clients.push(socket);
    connected.resolve(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received.push(chunk);
      if (received.join("").includes("\0")) message.resolve(received.join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    received,
    clients,
    connected: connected.promise,
    message: message.promise,
    close: () => {
      for (const client of clients) client.destroy();
      server.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
};

const open = (endpoint: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
  });

describe("Aside bridge", () => {
  it("carries CDP frames both ways as NUL-terminated messages", async () => {
    const helper = await fakeHelper();
    const bridge = await openAsideEndpoint(helper.socketPath);
    try {
      const socket = await open(bridge.endpoint);
      const messages: Array<string> = [];
      const delivered = Promise.withResolvers<void>();
      socket.addEventListener("message", (event) => {
        messages.push(String(event.data));
        if (messages.length === 2) delivered.resolve();
      });
      socket.send('{"id":1,"method":"Browser.getVersion"}');
      await helper.message;
      const sent = JSON.parse(helper.received.join("").split("\0")[0]!);
      expect(sent.method).toBe("Browser.getVersion");
      expect(sent.id).not.toBe(1);

      // One chunk can hold several messages, and a message can span chunks.
      helper.clients[0]!.write(`{"id":${sent.id},"result":{}}\0{"method":"Target.targe`);
      helper.clients[0]!.write('tCreated"}\0');
      await delivered.promise;
      expect(messages).toEqual(['{"id":1,"result":{}}', '{"method":"Target.targetCreated"}']);
      socket.close();
    } finally {
      await bridge.close();
      helper.close();
    }
  });

  it("ends Playwright's connection when the helper goes away", async () => {
    const helper = await fakeHelper();
    const bridge = await openAsideEndpoint(helper.socketPath);
    try {
      const socket = await open(bridge.endpoint);
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve(), { once: true }),
      );
      await helper.connected;
      helper.clients[0]!.destroy();
      await closed;
    } finally {
      await bridge.close();
      helper.close();
    }
  });

  it("says how to set Aside up when its helper is not running", async () => {
    const missing = NodePath.join(NodeOS.tmpdir(), "no-aside-helper", "cdp.sock");
    await expect(openAsideEndpoint(missing)).rejects.toThrow(ASIDE_UNAVAILABLE_MESSAGE);
    await expect(openAsideEndpoint(missing)).rejects.toBeInstanceOf(AsideUnavailableError);
  });
});

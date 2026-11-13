// @effect-diagnostics nodeBuiltinImport:off - Bridges Playwright's WebSocket transport to the Aside helper's Unix socket.
/**
 * Aside as a browser profile: its tabs are real tabs in the user's Aside browser. Aside's DevTools
 * pipe is lent over a user-only Unix socket (fork/scripts/aside-cdp-helper.mjs), and Playwright
 * needs a WebSocket URL, so a loopback endpoint with an unguessable path bridges to that socket.
 */
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { asideCdpFilter } from "./asideCdpFilter.ts";

export const ASIDE_UNAVAILABLE_MESSAGE =
  "Aside isn't running in T3 mode on this machine. Run fork/scripts/install-aside-helper.sh on it first.";

export class AsideUnavailableError extends Schema.TaggedError<AsideUnavailableError>()(
  "AsideUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return ASIDE_UNAVAILABLE_MESSAGE;
  }
}

const asideSocketPath = (env: NodeJS.ProcessEnv = process.env) =>
  env.T3_ASIDE_SOCKET ?? NodePath.join(NodeOS.homedir(), ".t3-aside", "cdp.sock");

const connectSocket = (socketPath: string) =>
  new Promise<NodeNet.Socket>((resolve, reject) => {
    const socket = NodeNet.createConnection(socketPath);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });

/**
 * A one-connection loopback CDP endpoint bridged to the helper. Closing the scope, or
 * the helper going away, ends the connection, which Playwright sees as a disconnect.
 */
const bridge = Effect.fn("asideBrowser.bridge")(function* (socketPath: string) {
  const helper = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => connectSocket(socketPath),
      catch: (cause) => new AsideUnavailableError({ cause }),
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  helper.setEncoding("utf8");
  const fromHelper = yield* Queue.unbounded<string>();
  const filter = asideCdpFilter(
    (raw) => {
      helper.write(`${raw}\0`);
    },
    (raw) => {
      Queue.offerUnsafe(fromHelper, raw);
    },
  );
  let buffer = "";
  helper.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\0")) >= 0) {
      filter.fromHelper(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
  helper.on("close", () => Queue.shutdownUnsafe(fromHelper));
  helper.on("error", () => Queue.shutdownUnsafe(fromHelper));

  const secret = NodeCrypto.randomBytes(24).toString("base64url");
  const server = yield* NodeSocketServer.makeWebSocket({
    host: "127.0.0.1",
    port: 0,
    path: `/${secret}`,
  });
  // The helper serves one Playwright connection; a second would see the first's sessions.
  let connected = false;
  yield* server
    .run((socket) =>
      Effect.gen(function* () {
        if (connected) return;
        connected = true;
        const writer = yield* socket.writer;
        const reader = yield* socket.reader;
        const decoder = new TextDecoder();
        const toHelper = reader.pull.pipe(
          Effect.flatMap((frames) =>
            Effect.sync(() => {
              for (const frame of frames) {
                filter.fromPlaywright(typeof frame === "string" ? frame : decoder.decode(frame));
              }
            }),
          ),
          Effect.forever,
        );
        // The helper going away ends the stream and with it this connection.
        const toPlaywright = Stream.fromQueue(fromHelper).pipe(
          Stream.runForEach((message) => writer.write(message)),
        );
        return yield* Effect.raceFirst(toHelper, toPlaywright);
      }).pipe(Effect.scoped, Effect.ignore),
    )
    .pipe(Effect.forkScoped);
  const address = server.address;
  if (address._tag !== "InetAddressV4") return yield* Effect.die("Unexpected bridge address.");
  return `ws://127.0.0.1:${address.port}/${secret}`;
});

/** Opens a bridge to Aside's helper; `close` ends it. Fails when the helper isn't running. */
export const openAsideEndpoint = async (socketPath = asideSocketPath()) => {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const result = await Effect.runPromiseExit(bridge(socketPath).pipe(Scope.provide(scope)));
    if (Exit.isFailure(result)) throw Cause.squash(result.cause);
    const endpoint = result.value;
    return {
      endpoint,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw cause;
  }
};

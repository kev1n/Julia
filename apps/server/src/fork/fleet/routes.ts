// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
/**
 * Fork (Owner): the fleet's HTTP routes, all under /fork/fleet and all
 * requiring the fleet secret (Authorization: Bearer). Reached over the
 * tailnet through each Mac's Tailscale Serve.
 *
 * - POST hub/publish, GET hub/index: the hub (only where fork-fleet.json says "hub": true).
 * - POST move/pack: another server taking a moved thread's branch as a git
 *   bundle (../moveThread.ts).
 * - POST peer/read, peer/send: another server's agent reading or messaging a
 *   thread here. The source server vouches for the calling thread; this server
 *   acts for it as a client whose permission ceiling is that thread's runtime
 *   mode, so the existing rule applies here, at the destination: a target may
 *   not run with broader modes than its caller. Idempotency keys are
 *   namespaced per source thread.
 */
import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadReadInput,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import { MoveFailure, packBranch } from "../moveThread.ts";
import { FleetOperationError, authorized } from "./config.ts";
import { hubIndex, hubPublish } from "./hub.ts";
import { FleetSnapshot } from "./model.ts";
import * as FleetSuggestions from "./threadOverlaps.ts";
import { fleetConfig } from "./publisher.ts";

export const PeerSource = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  runtimeMode: RuntimeMode,
});
export type PeerSource = typeof PeerSource.Type;

const PeerRead = Schema.Struct({ source: PeerSource, input: OrchestratorMcpThreadReadInput });
const PeerSend = Schema.Struct({
  source: PeerSource,
  input: Schema.Struct({
    threadId: ThreadId,
    message: Schema.String,
    mode: Schema.Literals(["auto", "queue", "steer"]),
    clientRequestId: Schema.String,
  }),
});

const MovePack = Schema.Struct({
  worktreePath: Schema.String,
  branch: Schema.String,
  commitMessage: Schema.String,
  haves: Schema.Array(Schema.String),
});

const decodeSuggestionRequest = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: Schema.String, threadId: Schema.String }),
);
const decodeSnapshot = Schema.decodeUnknownEffect(FleetSnapshot);
const decodeMovePack = Schema.decodeUnknownEffect(MovePack);
const isMoveFailure = Schema.is(MoveFailure);
const decodePeerRead = Schema.decodeUnknownEffect(PeerRead);
const decodePeerSend = Schema.decodeUnknownEffect(PeerSend);
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const peerScope = (environmentId: string, source: PeerSource): McpInvocationScope => ({
  environmentId: environmentId as McpInvocationScope["environmentId"],
  capabilities: new Set(["orchestration"]),
  issuedAt: Date.now(),
  requestNamespace: `fleet:${source.environmentId}:${source.threadId}`,
  thread: undefined,
  client: {
    sessionId: `fleet:${source.environmentId}:${source.threadId}`,
    label: `${source.label} · ${source.title}`,
    access: source.runtimeMode,
  },
});

const asReply = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map((result) => json({ ok: true, result })),
    Effect.catch((error) =>
      Effect.succeed(
        isOrchestratorMcpFailure(error)
          ? json({ ok: false, failure: { code: error.code, message: error.message } })
          : json({ error: String(error) }, 500),
      ),
    ),
  );

// Services are captured when the layer is built: a route handler's own
// requirements would otherwise fall through to the HTTP server.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const suggestions = yield* FleetSuggestions.FleetSuggestions;
    return HttpRouter.add("*", "/fork/fleet/*", handle(environment, service, suggestions));
  }),
);

const handle = (
  environment: ServerEnvironment.ServerEnvironment["Service"],
  service: OrchestratorMcpService.OrchestratorMcpService["Service"],
  suggestions: FleetSuggestions.FleetSuggestions["Service"],
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = fleetConfig();
    if (config === null || !authorized(config, request.headers["authorization"])) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const path = new URL(request.url, "http://local").pathname.slice("/fork/fleet/".length);
    if (path === "hub/suggestions" && config.hub && request.method === "POST") {
      const decoded = yield* decodeSuggestionRequest(yield* request.json).pipe(Effect.result);
      if (decoded._tag === "Failure") return json({ error: "invalid request" }, 400);
      return json(
        yield* suggestions.read(decoded.success.threadId, {
          environmentId: decoded.success.environmentId,
        }),
      );
    }
    if (path === "hub/index" && config.hub) return json(hubIndex(Date.now()));
    if (path === "hub/publish" && config.hub && request.method === "POST") {
      const snapshot = yield* decodeSnapshot(yield* request.json).pipe(Effect.result);
      if (snapshot._tag === "Failure") return json({ error: "invalid snapshot" }, 400);
      return json(hubPublish(snapshot.success, Date.now()));
    }
    if (path === "move/pack" && request.method === "POST") {
      const decoded = yield* decodeMovePack(yield* request.json).pipe(Effect.result);
      if (decoded._tag === "Failure") return json({ error: "invalid request" }, 400);
      const packed = yield* Effect.tryPromise({
        try: () => packBranch(decoded.success),
        catch: (cause) => new FleetOperationError({ cause }),
      }).pipe(Effect.result);
      if (packed._tag === "Failure") {
        const cause = packed.failure.cause;
        return HttpServerResponse.text(
          isMoveFailure(cause) ? cause.message : `move failed: ${String(cause)}`,
          { status: isMoveFailure(cause) ? 409 : 500 },
        );
      }
      const { head, bundle } = packed.success;
      const headers = { "x-fork-move-head": head };
      return bundle === null
        ? HttpServerResponse.empty({ status: 204, headers })
        : HttpServerResponse.uint8Array(bundle, {
            headers,
            contentType: "application/x-git-bundle",
          });
    }
    if (request.method !== "POST" || (path !== "peer/read" && path !== "peer/send")) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const descriptor = yield* environment.getDescriptor;
    const body = yield* request.json;
    if (path === "peer/read") {
      const decoded = yield* decodePeerRead(body).pipe(Effect.result);
      if (decoded._tag === "Failure") return json({ error: "invalid request" }, 400);
      const { source, input } = decoded.success;
      return yield* asReply(service.readThread(peerScope(descriptor.environmentId, source), input));
    }
    const decoded = yield* decodePeerSend(body).pipe(Effect.result);
    if (decoded._tag === "Failure") return json({ error: "invalid request" }, 400);
    const { source, input } = decoded.success;
    const message = `[Fleet message from ${source.label}, thread "${source.title}" (${source.environmentId}/${source.threadId})]\n\n${input.message}`;
    return yield* asReply(
      service.sendToThread(peerScope(descriptor.environmentId, source), { ...input, message }),
    );
  }).pipe(Effect.catchCause(() => Effect.succeed(json({ error: "fleet route failed" }, 500))));

// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
/**
 * Fork (Owner): the fleet's HTTP routes under /fork/fleet, all requiring the fleet secret, reached
 * over the tailnet. A peer read or send acts for the calling thread as a client capped at that
 * thread's runtime mode, so a target never runs with broader modes than its caller; idempotency
 * keys are namespaced per source thread.
 */
import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadReadInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ForkDrain from "../drain.ts";
import { MoveFailure, packBranch } from "../moveThread.ts";
import { authorized } from "./config.ts";
import { hubIndex, hubPublish } from "./hub.ts";
import { FleetSnapshot } from "./model.ts";
import { PeerSource, peerScope } from "./peer.ts";
import * as RemoteTasks from "./remoteTasks.ts";
import * as FleetSuggestions from "./threadOverlaps.ts";
import { fleetConfig } from "./publisher.ts";

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

const decodeDrain = Schema.decodeUnknownEffect(
  Schema.Struct({
    action: Schema.Literals(["peek", "start", "cancel"]),
    release: Schema.String,
    requester: Schema.optional(Schema.String),
  }),
);
const decodeSuggestionRequest = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: Schema.String, threadId: Schema.String }),
);
const decodeSnapshot = Schema.decodeUnknownEffect(FleetSnapshot);
const decodeMovePack = Schema.decodeUnknownEffect(MovePack);
const decodePeerRead = Schema.decodeUnknownEffect(PeerRead);
const decodePeerSend = Schema.decodeUnknownEffect(PeerSend);
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

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
    const remoteTasks = yield* RemoteTasks.makePeerHandlers;
    // Optional, so a layer built without the database (tests) still builds; the
    // server provides it, and without it the drain answers 404 like an old server.
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    return HttpRouter.add(
      "*",
      "/fork/fleet/*",
      handle(environment, service, suggestions, remoteTasks, sql),
    );
  }),
);

const handle = (
  environment: ServerEnvironment.ServerEnvironment["Service"],
  service: OrchestratorMcpService.OrchestratorMcpService["Service"],
  suggestions: FleetSuggestions.FleetSuggestions["Service"],
  remoteTasks: RemoteTasks.PeerHandlers,
  sql: Option.Option<SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = fleetConfig();
    if (config === null || !authorized(config, request.headers["authorization"])) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const path = new URL(request.url, "http://local").pathname.slice("/fork/fleet/".length);
    if (path === "drain" && request.method === "POST" && Option.isSome(sql)) {
      const decoded = yield* decodeDrain(yield* request.json).pipe(Effect.result);
      if (decoded._tag === "Failure") return json({ error: "invalid request" }, 400);
      const { action, release, requester } = decoded.success;
      return json(
        yield* action === "cancel"
          ? ForkDrain.cancel(release)
          : (action === "peek"
              ? ForkDrain.peek(requester ?? null)
              : ForkDrain.start(release, requester ?? null)
            ).pipe(Effect.provideService(SqlClient.SqlClient, sql.value)),
      );
    }
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
      const packed = yield* Effect.tryPromise(() => packBranch(decoded.success)).pipe(
        Effect.result,
      );
      if (packed._tag === "Failure") {
        const cause = packed.failure.cause;
        return HttpServerResponse.text(
          cause instanceof MoveFailure ? cause.message : `move failed: ${String(cause)}`,
          { status: cause instanceof MoveFailure ? 409 : 500 },
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
    const remoteTask = remoteTasks.get(path);
    if (remoteTask !== undefined && request.method === "POST") {
      return yield* asReply(remoteTask(yield* request.json));
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

// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
/** Fork (Owner): the fleet tools' handlers. */
import {
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadSendResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import { readCaller } from "../../mcp/threadAccess.ts";
import { FleetHttpError, FleetOperationError, STALE_AFTER_MS, fleetRequest } from "./config.ts";
import { findOverlaps, isActive } from "./fleetIndex.ts";
import type { FleetIntent } from "./model.ts";
import { fleetConfig, localSnapshot, refreshNow, setIntents } from "./publisher.ts";
import type { PeerSource } from "./routes.ts";
import { FleetToolkit } from "./tools.ts";
import { loadView, overlapOut, summarize, type FleetView } from "./view.ts";

const fail = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const view = (refresh: Effect.Effect<unknown> = Effect.void) =>
  Effect.gen(function* () {
    yield* refresh;
    return yield* Effect.promise(() => loadView(fleetConfig(), localSnapshot()));
  });

const envelope = (current: FleetView) => ({
  asOf: current.asOf,
  hub: current.hub,
  coverage: current.coverage,
});

/** The calling thread (a fleet answer is always about a thread). */
const callerThread = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  if (scope.thread === undefined || caller === undefined) {
    return yield* fail(
      "thread_credential_required",
      "Fleet awareness answers for a calling thread.",
    );
  }
  return caller;
});

/** Rescan the caller's checkout, publish, then compute overlaps for it. */
const overlapsForCaller = (extraKeys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const caller = yield* callerThread;
    const before = localSnapshot();
    const own = before?.threads.find((thread) => thread.threadId === caller.id);
    const path = own?.checkoutKey?.slice(own.environmentId.length + 1);
    const current = yield* view(
      refreshNow(path === undefined ? "active" : new Set([path])).pipe(Effect.ignore),
    );
    const snapshot = localSnapshot();
    const me = snapshot?.threads.find((thread) => thread.threadId === caller.id) ?? null;
    if (me === null) return { current, me: null, overlaps: [] };
    const myCheckout = snapshot?.checkouts.find((checkout) => checkout.key === me.checkoutKey);
    const overlaps = findOverlaps({
      me,
      myCheckout,
      extraKeys,
      entries: current.entries,
      now: current.now,
      staleAfterMs: STALE_AFTER_MS,
    });
    return {
      current,
      me: summarize(current, me),
      overlaps: overlaps.map((overlap) => overlapOut(current, overlap)),
    };
  });

const peerSource = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    threadId: caller?.id ?? `client:${scope.client?.sessionId ?? "unknown"}`,
    title: caller?.title ?? scope.client?.label ?? "client",
    runtimeMode: caller?.runtimeMode ?? McpInvocationContext.clientRuntimeModeCeiling(scope.client),
  } satisfies PeerSource;
});

const owner = (current: FleetView, environmentId: string) =>
  Effect.gen(function* () {
    const entry = current.entries.find(
      (candidate) => candidate.snapshot.environmentId === environmentId,
    );
    if (entry === undefined) {
      return yield* fail(
        "thread_not_found",
        `Environment ${environmentId} is not in the fleet index (hub ${current.hub}).`,
      );
    }
    return entry.snapshot;
  });

type PeerReply<A> =
  | { readonly ok: true; readonly result: A }
  | {
      readonly ok: false;
      readonly failure: { code: OrchestratorMcpFailure["code"]; message: string };
    };

/**
 * Access (McpToolAccess): listing, overlaps and reading change nothing;
 * publishing intents acts as the calling thread; sending writes the target
 * thread, checked here when it is on this server and by the destination
 * server (the sender's modes are its ceiling, routes.ts) when it is not.
 */
const isFleetHttpError = Schema.is(FleetHttpError);

const handlers = {
  t3_fleet_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const current = yield* view();
      let repo = input.repo;
      if (repo === "current") {
        const caller = yield* callerThread;
        repo =
          localSnapshot()?.threads.find((thread) => thread.threadId === caller.id)?.repoKey ??
          undefined;
      }
      const threads = current.entries
        .flatMap((entry) => entry.snapshot.threads)
        .filter((thread) => (input.includeInactive === true ? true : isActive(thread)))
        .filter((thread) => repo === undefined || thread.repoKey === repo)
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
        .map((thread) => summarize(current, thread));
      return { ...envelope(current), threads };
    }),
  ),
  t3_who_else: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { current, me, overlaps } = yield* overlapsForCaller(input.paths ?? []);
      return { ...envelope(current), me, overlaps };
    }),
  ),
  t3_work_publish: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerThread;
      if (fleetConfig() === null)
        return yield* fail("invalid_request", "The fleet is not configured.");
      setIntents(caller.id, input.intents as ReadonlyArray<FleetIntent>, Date.now());
      const { current, me, overlaps } = yield* overlapsForCaller([]);
      return { ...envelope(current), published: input.intents.length, me, overlaps };
    }),
  ),
  t3_fleet_thread_read: McpToolAccess.reads(({ environmentId, ...readInput }) =>
    Effect.gen(function* () {
      const current = yield* view();
      const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
      if (environmentId === descriptor.environmentId) {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.readThread(scope, readInput);
        return { ...envelope(current), environmentId, result };
      }
      const target = yield* owner(current, environmentId);
      const source = yield* peerSource;
      const reply = (yield* Effect.tryPromise({
        try: () =>
          fleetRequest(fleetConfig()!, `${target.baseUrl}/fork/fleet/peer/read`, {
            source,
            input: readInput,
          }),
        catch: (cause) => new FleetOperationError({ cause }),
      }).pipe(
        Effect.mapError((error) =>
          fail(
            "orchestration_error",
            `${target.label} did not answer: ${String(error.cause ?? error)}`,
          ),
        ),
      )) as PeerReply<OrchestratorMcpThreadReadResult>;
      if (!reply.ok)
        return yield* fail(reply.failure.code, `${target.label}: ${reply.failure.message}`);
      return { ...envelope(current), environmentId, result: reply.result };
    }),
  ),
  t3_fleet_thread_send: McpToolAccess.writesThreads(
    (input) => [ThreadId.make(input.threadId)],
    (input) =>
      Effect.gen(function* () {
        const current = yield* view();
        const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
        const sendInput = {
          threadId: ThreadId.make(input.threadId),
          message: input.message,
          mode: input.mode ?? "auto",
          clientRequestId: input.idempotencyKey,
        } as const;
        if (input.environmentId === descriptor.environmentId) {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.sendToThread(scope, sendInput);
          return { ...envelope(current), outcome: "delivered" as const, result };
        }
        const target = yield* owner(current, input.environmentId);
        const source = yield* peerSource;
        const attempt = yield* Effect.tryPromise({
          try: () =>
            fleetRequest(fleetConfig()!, `${target.baseUrl}/fork/fleet/peer/send`, {
              source,
              input: sendInput,
            }),
          catch: (cause) => new FleetOperationError({ cause }),
        }).pipe(Effect.result);
        if (attempt._tag === "Failure") {
          const cause = attempt.failure.cause;
          if (isFleetHttpError(cause) && cause.ambiguous) {
            return {
              ...envelope(current),
              outcome: "unknown" as const,
              result: null,
              note: `No answer from ${target.label} (${cause.message}). The message may or may not have been delivered; it was not retried. Retry with the same idempotencyKey to deliver it at most once.`,
            };
          }
          return yield* fail("orchestration_error", `${target.label}: ${String(cause)}`);
        }
        const reply = attempt.success as PeerReply<OrchestratorMcpThreadSendResult>;
        if (!reply.ok)
          return yield* fail(reply.failure.code, `${target.label}: ${reply.failure.message}`);
        return { ...envelope(current), outcome: "delivered" as const, result: reply.result };
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof FleetToolkit.tools>;

export const layer = McpToolAccess.toLayer(FleetToolkit, handlers);

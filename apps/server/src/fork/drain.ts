/**
 * Fork (Owner): the drain before a planned restart (FORK.md, "Restarts keep background work").
 * While draining, ThreadManagementService.dispatch refuses new work from clients and agents but
 * not the server's own continuations; it refuses rather than queues, since startup recovery holds
 * queued messages. In memory only: the restart, or the deploy script cancelling, ends it.
 */
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OrchestratorCommandRejectedError } from "../orchestration-v2/Orchestrator.ts";
import { type LiveWorkItem, liveWork, threadsOfProviderSession } from "./liveWork.ts";

const REFUSAL = "Not taking new work: this machine restarts for an update";

let drain: { readonly release: string; waitingFor: ReadonlyArray<string> } | null = null;
let accepting = 0;

type NewWork = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.create" | "message.dispatch" | "delegated_task.request" }
>;

const isNewWork = (command: OrchestrationV2ServerCommand): command is NewWork =>
  command.type === "thread.create" ||
  command.type === "message.dispatch" ||
  command.type === "delegated_task.request";

const refusalText = (waitingFor: ReadonlyArray<string>) =>
  `${REFUSAL} as soon as its running work finishes (${
    waitingFor.length === 0 ? "it restarts now" : `waiting for ${waitingFor.join(", ")}`
  }). Send this to another machine, or again after the restart.`;

/**
 * Runs `dispatch` unless a drain refuses `command`. `accepted` says whether the
 * command or its message was accepted before; it is read only while draining.
 */
export const admit = <A, E, R>(
  command: OrchestrationV2ServerCommand,
  accepted: Effect.Effect<boolean>,
  dispatch: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OrchestratorCommandRejectedError, R> => {
  if (!isNewWork(command)) return dispatch;
  return Effect.suspend(() => {
    accepting += 1;
    return Effect.gen(function* () {
      const current = drain;
      const fromOutside =
        command.creationSource === "web" ||
        command.creationSource === "mobile" ||
        command.creationSource === "mcp";
      if (current !== null && fromOutside && !(yield* accepted)) {
        return yield* new OrchestratorCommandRejectedError({
          commandId: command.commandId,
          commandType: command.type,
          cause: refusalText(current.waitingFor),
        });
      }
      return yield* dispatch;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          accepting -= 1;
        }),
      ),
    );
  });
};

const isRejected = Schema.is(OrchestratorCommandRejectedError);

/** The refusal's text when `cause` is one, for callers that would hide it. */
export const refusalIn = (cause: unknown): string | undefined =>
  isRejected(cause) && typeof cause.cause === "string" && cause.cause.startsWith(REFUSAL)
    ? cause.cause
    : undefined;

const view = ({ kind, title, what }: LiveWorkItem) => ({ kind, title, what });

/**
 * What a restart would still cut off. `requester` is the requesting agent's
 * provider session id; its thread's work is left out, so an agent that waits
 * for its own deploy does not hold it up.
 */
const status = Effect.fn("drain.status")(function* (requester: string | null) {
  // Read before the projections: a command counted here may commit after them.
  const uncommitted = accepting;
  const requesting = new Set(requester === null ? [] : yield* threadsOfProviderSession(requester));
  const work = yield* liveWork;
  const waiting = work.filter((item) => !requesting.has(item.threadId));
  const waitingFor = waiting.map(view);
  if (uncommitted > 0) {
    waitingFor.push({ kind: "accepting", title: "", what: `${uncommitted} new command(s)` });
  }
  return {
    idle: waitingFor.length === 0,
    waitingFor,
    titles: [...new Set(waiting.map((item) => item.title))],
    notWaitingFor: work.filter((item) => requesting.has(item.threadId)).map(view),
  };
});

/** The status without draining: new work is still admitted. */
export const peek = (requester: string | null) =>
  status(requester).pipe(
    Effect.map(({ idle, waitingFor, notWaitingFor }) => ({ idle, waitingFor, notWaitingFor })),
  );

/**
 * Starts draining for `release` (or keeps draining) and reports what the
 * restart still waits for. The script starts it only after `peek` reported
 * idle, and cancels it at once when this answer is not idle, so new work is
 * refused only between idle and the restart.
 */
export const start = Effect.fn("drain.start")(function* (
  release: string,
  requester: string | null,
) {
  if (drain?.release !== release) drain = { release, waitingFor: [] };
  const current = drain;
  const { titles, ...answer } = yield* status(requester);
  current.waitingFor = titles;
  return answer;
});

/** Stops draining for `release`; a drain for a newer release stays. */
export const cancel = (release: string) =>
  Effect.sync(() => {
    if (drain?.release === release) drain = null;
    return { draining: drain !== null };
  });

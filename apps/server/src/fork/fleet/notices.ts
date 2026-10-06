// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork (Owner): overlap notes on the server that owns the thread.
 *
 * T3 has no passive inbox: every existing way to message a thread either
 * steers the running turn or starts a new one. So:
 * - an interrupt steers the thread's running turn now (T3's own steer);
 * - a passive note waits here, in `fork-fleet-notices.json`, until the
 *   thread starts its next turn, and is then steered into that turn. A note
 *   queued while a turn is running waits for the turn after it, so a passive
 *   note never lands in the turn that was running when it arrived;
 * - an interrupt that finds no running turn becomes a passive note;
 * - the hub withdraws a waiting note when its overlap ends or changes.
 * Nothing here ever starts a turn on an idle thread.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { HEARTBEAT_MS, readFleetConfig } from "./config.ts";

export const NoticeRequest = Schema.Struct({
  /** Directed pair key from the hub; one waiting note per pair. */
  key: Schema.String,
  noticeId: Schema.String,
  threadId: Schema.String,
  level: Schema.Literals(["interrupt", "passive", "withdraw"]),
  text: Schema.optional(Schema.String),
});
export type NoticeRequest = typeof NoticeRequest.Type;

export type NoticeOutcome = "interrupted" | "queued" | "withdrawn" | "thread-gone";

interface PendingNotice {
  readonly noticeId: string;
  readonly threadId: string;
  readonly text: string;
  /** The run that was active when the note arrived; it is not "the next turn". */
  readonly notBeforeRunId: string | null;
  readonly at: number;
}

type ThreadManagement = ThreadManagementService.ThreadManagementService["Service"];

let userdataDir: string | null = null;
let pending: Map<string, PendingNotice> | null = null;
const inFlight = new Set<string>();

const storePath = () => NodePath.join(userdataDir!, "fork-fleet-notices.json");

function store(): Map<string, PendingNotice> {
  if (pending !== null) return pending;
  try {
    pending = new Map(
      Object.entries(
        JSON.parse(NodeFS.readFileSync(storePath(), "utf8")) as Record<string, PendingNotice>,
      ),
    );
  } catch {
    pending = new Map();
  }
  return pending;
}

function save() {
  const temporary = `${storePath()}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify(Object.fromEntries(store())), { mode: 0o600 });
  NodeFS.renameSync(temporary, storePath());
}

const isNoSteerableRun = Schema.is(ThreadManagementService.ThreadManagementNoSteerableRunError);

/** Steer `text` into the thread's running turn. Ids derive from the note, so a repeat is a no-op. */
const steer = (
  threads: ThreadManagement,
  input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly noticeId: string;
    readonly text: string;
  },
) =>
  threads.sendToThread({
    projectId: ProjectId.make(input.projectId),
    commandId: CommandId.make(`command:fork-fleet-notice:${input.noticeId}`),
    threadId: ThreadId.make(input.threadId),
    messageId: MessageId.make(`message:fork-fleet-notice:${input.noticeId}`),
    text: input.text,
    attachments: [],
    mode: "steer",
    createdBy: "system",
    creationSource: "server",
  });

const liveShell = (threads: ThreadManagement, threadId: string) =>
  threads
    .getThreadShell(ThreadId.make(threadId))
    .pipe(
      Effect.map((shell) =>
        shell === null || shell.deletedAt !== null || shell.archivedAt !== null ? null : shell,
      ),
    );

/** Handle one notice from the hub. */
export const receiveNotice = Effect.fn("fork.fleet.receiveNotice")(function* (
  threads: ThreadManagement,
  request: NoticeRequest,
) {
  const notes = store();
  if (request.level === "withdraw") {
    if (notes.delete(request.key)) save();
    return "withdrawn" satisfies NoticeOutcome;
  }
  const shell = yield* liveShell(threads, request.threadId);
  if (shell === null) {
    if (notes.delete(request.key)) save();
    return "thread-gone" satisfies NoticeOutcome;
  }
  const text = request.text ?? "";
  if (request.level === "interrupt") {
    const steered = yield* steer(threads, {
      projectId: shell.projectId,
      threadId: request.threadId,
      noticeId: request.noticeId,
      text,
    }).pipe(Effect.result);
    if (steered._tag === "Success") {
      if (notes.delete(request.key)) save();
      return "interrupted" satisfies NoticeOutcome;
    }
    if (!isNoSteerableRun(steered.failure)) return yield* steered.failure;
  }
  notes.set(request.key, {
    noticeId: request.noticeId,
    threadId: request.threadId,
    text,
    // A failed interrupt may land in the turn that is starting; a passive note waits for the next one.
    notBeforeRunId: request.level === "interrupt" ? null : shell.activeRunId,
    at: Date.now(),
  });
  save();
  return "queued" satisfies NoticeOutcome;
});

/** Steer waiting notes into threads whose next turn is running. */
const deliverWaiting = (threads: ThreadManagement, onlyThreadId?: string) =>
  Effect.gen(function* () {
    const notes = store();
    for (const [key, note] of notes) {
      if (onlyThreadId !== undefined && note.threadId !== onlyThreadId) continue;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      yield* Effect.gen(function* () {
        const shell = yield* liveShell(threads, note.threadId);
        if (shell === null) {
          notes.delete(key);
          save();
          return;
        }
        if (shell.activeRunId === null || shell.activeRunId === note.notBeforeRunId) return;
        const steered = yield* steer(threads, {
          projectId: shell.projectId,
          threadId: note.threadId,
          noticeId: note.noticeId,
          text: note.text,
        }).pipe(Effect.result);
        // The provider turn may not be running yet: the next event or heartbeat tries again.
        if (steered._tag === "Failure" && isNoSteerableRun(steered.failure)) return;
        if (steered._tag === "Failure") {
          yield* Effect.logWarning("fleet notice not delivered", {
            threadId: note.threadId,
            error: String(steered.failure),
          });
          return;
        }
        // The hub may have replaced the note meanwhile; only drop the one delivered.
        if (notes.get(key)?.noticeId === note.noticeId) notes.delete(key);
        save();
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("fleet notice delivery failed", { cause })),
        Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
      );
    }
  });

const TURN_EVENTS: ReadonlySet<string> = new Set([
  "run.created",
  "run.updated",
  "provider-turn.updated",
]);

/** Forked for the server's lifetime: deliver on turn events, and every heartbeat as a backstop. */
export const runNoticeDelivery = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const config = readFleetConfig(NodePath.dirname(serverConfig.environmentIdPath));
  if (config === null) return;
  userdataDir = config.userdataDir;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* threads.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        TURN_EVENTS.has(event.type) &&
        [...store().values()].some((note) => note.threadId === event.threadId),
    ),
    // Forked, so a delivery (which dispatches and waits on this server) never holds up the stream.
    Stream.runForEach((event) =>
      deliverWaiting(threads, event.threadId).pipe(Effect.forkDetach, Effect.asVoid),
    ),
    Effect.catchCause((cause) => Effect.logWarning("fleet notice events stopped", { cause })),
    Effect.forkScoped,
  );
  yield* deliverWaiting(threads).pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(HEARTBEAT_MS))),
  );
});

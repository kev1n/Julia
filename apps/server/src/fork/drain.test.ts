import {
  CommandId,
  MessageId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ForkDrain from "./drain.ts";

const RELEASE = "owner-1.0.0-abc1234";

/** The real dispatch chokepoint over a mocked orchestrator that records what reached it. */
const layerTest = (dispatched: Array<string>) =>
  ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              id: ThreadId.make("thread-new"),
              projectId: ProjectId.make("project-1"),
              deletedAt: null,
              modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "x" },
            },
            messages: [],
          } as unknown as OrchestrationV2ThreadProjection),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command.commandId);
            return { sequence: 1, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(ServerSettings.layerTest({})),
    Layer.provide(CommandReceiptStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const message = (
  id: string,
  creationSource: "web" | "mcp" | "server",
): OrchestrationV2ServerCommand => ({
  type: "message.dispatch",
  commandId: CommandId.make(id),
  threadId: ThreadId.make("thread-new"),
  messageId: MessageId.make(id),
  text: "hello",
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  createdBy: creationSource === "server" ? "agent" : "user",
  creationSource,
});

/**
 * A thread whose turn is running, and one whose turn completed but left a Claude
 * subagent running: the requesting agent, whose provider session id is the one its
 * shell sees as CLAUDE_CODE_SESSION_ID.
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES
      ('thread-busy', 'project-1', 'Busy', 'claudeAgent', 'full-access', 'default', '2026-10-16', '2026-10-16', '{}'),
      ('thread-requester', 'project-1', 'Deploys', 'claudeAgent', 'full-access', 'default', '2026-10-16', '2026-10-16', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, status, requested_at, payload_json, provider_thread_id)
    VALUES
      ('run-busy', 'thread-busy', 1, 'claudeAgent', 'running', '2026-10-16', '{}', NULL),
      ('run-requester', 'thread-requester', 1, 'claudeAgent', 'completed', '2026-10-16', '{}', 'pt-requester')`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
    (provider_session_id, thread_id, provider, status, updated_at, payload_json)
    VALUES ('session-requester', 'thread-requester', 'claudeAgent', 'ready', '2026-10-16', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
    (provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json)
    VALUES ('pt-requester', 'thread-requester', 'claudeAgent', 'session-requester', 'idle', '2026-10-16',
      '{"nativeThreadRef":{"driver":"claudeAgent","nativeId":"claude-session-1","strength":"strong"}}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, run_id, provider_thread_id, ordinal, type, status, updated_at, payload_json)
    VALUES ('item-audit', 'thread-requester', 'run-requester', 'pt-requester', 1, 'subagent', 'running',
      '2026-10-16', '{"title":"Audit","origin":"provider_native"}')`;
});

const finishBusyRun = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-busy'`,
);

const finishAudit = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`UPDATE orchestration_v2_projection_turn_items SET status = 'completed' WHERE turn_item_id = 'item-audit'`,
);

it.effect("while work is live the deploy waits without draining: new work is admitted", () => {
  const dispatched: Array<string> = [];
  return Effect.gen(function* () {
    yield* seed;
    const threads = yield* ThreadManagementService.ThreadManagementService;

    const waiting = yield* ForkDrain.peek(null);
    assert.isFalse(waiting.idle);
    assert.deepEqual(
      waiting.waitingFor.map((item) => item.title),
      ["Busy", "Deploys"],
    );
    yield* threads.dispatch(message("from-web", "web"));
    yield* threads.dispatch(message("from-agent", "mcp"));
    assert.deepEqual(dispatched, ["from-web", "from-agent"]);

    yield* finishBusyRun;
    yield* finishAudit;
    assert.isTrue((yield* ForkDrain.peek(null)).idle);
  }).pipe(Effect.provide(layerTest(dispatched)));
});

it.effect("a drain started on idle that finds new work refuses work until cancelled", () => {
  const dispatched: Array<string> = [];
  return Effect.gen(function* () {
    yield* seed;
    yield* finishBusyRun;
    yield* finishAudit;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    assert.isTrue((yield* ForkDrain.peek(null)).idle);

    // Work starts between the idle peek and the drain.
    yield* SqlClient.SqlClient.pipe(
      Effect.flatMap(
        (sql) =>
          sql`UPDATE orchestration_v2_projection_runs SET status = 'running' WHERE run_id = 'run-busy'`,
      ),
    );
    const draining = yield* ForkDrain.start(RELEASE, null);
    assert.isFalse(draining.idle);
    assert.deepEqual(draining.waitingFor, [{ kind: "run running", title: "Busy", what: "" }]);

    // While it drains, a person's message and an agent's tool call are refused and
    // say why; the server's own continuation of live work still runs.
    for (const command of [message("from-web", "web"), message("from-agent", "mcp")]) {
      const error = yield* Effect.flip(threads.dispatch(command));
      assert.instanceOf(error, Orchestrator.OrchestratorCommandRejectedError);
      assert.include(String(ForkDrain.refusalIn(error)), "waiting for Busy");
    }
    yield* threads.dispatch(message("wake", "server"));

    // The script cancels a drain that is not idle: new work is admitted again.
    yield* ForkDrain.cancel(RELEASE);
    yield* threads.dispatch(message("after-cancel", "web"));
    assert.deepEqual(dispatched, ["wake", "after-cancel"]);
  }).pipe(Effect.provide(layerTest(dispatched)));
});

it.effect("the requesting thread does not hold up its own deploy", () =>
  Effect.gen(function* () {
    yield* seed;
    const waiting = yield* ForkDrain.peek("claude-session-1");
    assert.deepEqual(waiting.waitingFor, [{ kind: "run running", title: "Busy", what: "" }]);
    assert.deepEqual(waiting.notWaitingFor, [
      { kind: "subagent", title: "Deploys", what: "Audit" },
    ]);

    yield* finishBusyRun;
    // Its own subagent still runs; the restart may cut it off.
    assert.isTrue((yield* ForkDrain.peek("claude-session-1")).idle);
    assert.isTrue((yield* ForkDrain.start(RELEASE, "claude-session-1")).idle);
    yield* ForkDrain.cancel(RELEASE);
  }).pipe(Effect.provide(layerTest([]))),
);

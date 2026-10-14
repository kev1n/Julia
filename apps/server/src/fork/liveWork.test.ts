import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../persistence/Migrations.ts";

/** The deploy idle check's output for a migrated state database. */
const liveWork = (databasePath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const script = path.join(import.meta.dirname, "../../../../fork/scripts/live-work.sh");
    const output = yield* spawner.string(ChildProcess.make("bash", [script, databasePath]));
    return output.split("\n").filter((line) => line !== "");
  });

/**
 * One thread whose turn completed and left a Claude subagent and a Monitor running,
 * the shape of "Discuss Email with Example Person" on mac-a on 2026-10-14.
 */
const seed = (sessionStatus: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('thread-1', 'project-1', 'Example Person', 'claudeAgent', 'full-access', 'default', '2026-10-14', '2026-10-14', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json, provider_thread_id)
      VALUES ('run-1', 'thread-1', 1, 'claudeAgent', 'completed', '2026-10-14', '{}', 'provider-thread-1')`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
      (provider_session_id, thread_id, provider, status, updated_at, payload_json)
      VALUES ('session-1', 'thread-1', 'claudeAgent', ${sessionStatus}, '2026-10-14', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json)
      VALUES ('provider-thread-1', 'thread-1', 'claudeAgent', 'session-1', 'idle', '2026-10-14',
        '{"pendingBackgroundTasks":[{"taskId":"b1","kind":"monitor","description":"build-mac install"}]}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, provider_thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES
        ('item-1', 'thread-1', 'run-1', 'provider-thread-1', 1, 'subagent', 'running', '2026-10-14',
          '{"title":"Fix Orchestrator interrupt","origin":"provider_native"}'),
        -- A delegate_task child reports through its own thread's runs.
        ('item-2', 'thread-1', 'run-1', 'provider-thread-1', 2, 'subagent', 'running', '2026-10-14',
          '{"title":"Delegated","origin":"app_owned","childThreadId":"thread-2"}')`;
  });

const databaseWith = (sessionStatus: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const databasePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "live-work-" }),
      "statev2.sqlite",
    );
    yield* seed(sessionStatus).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    );
    return yield* liveWork(databasePath);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("counts background work a completed turn left running as live", () =>
  Effect.gen(function* () {
    assert.deepEqual((yield* databaseWith("ready")).toSorted(), [
      "monitor\tExample Person\tbuild-mac install",
      "subagent\tExample Person\tFix Orchestrator interrupt",
    ]);
  }),
);

it.effect("ignores leftover background rows of a stopped provider session", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* databaseWith("stopped"), []);
  }),
);

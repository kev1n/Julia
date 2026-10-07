import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { makeClaudeAuth } from "./claudeAuth.ts";

const instanceId = ProviderInstanceId.make("claude_work");

const makeHarness = (verified: boolean) =>
  Effect.gen(function* () {
    const spawned: Array<PtyAdapter.PtySpawnInput> = [];
    const written: Array<string> = [];
    const changed: Array<boolean> = [];
    let data: ((value: string) => void) | undefined;
    let exit: ((event: { exitCode: number; signal: number | null }) => void) | undefined;
    const controller = yield* makeClaudeAuth({
      instanceId,
      binaryPath: "/bin/claude",
      configDir: "/home/.claude_work",
      environment: { CLAUDE_CONFIG_DIR: "/home/.claude_work" },
      cwd: "/workspace",
      onChanged: (signedIn) =>
        Effect.gen(function* () {
          changed.push(signedIn);
          if (signedIn && !verified) {
            return yield* new ProviderSetupError({
              instanceId,
              operation: "start",
              detail: "Not logged in",
            });
          }
        }),
    }).pipe(
      Effect.provideService(PtyAdapter.PtyAdapter, {
        spawn: (input) =>
          Effect.sync(() => {
            spawned.push(input);
            return {
              pid: 1,
              write: (value) => {
                written.push(value);
              },
              resize: () => {},
              kill: () => {},
              onData: (callback) => {
                data = callback;
                return () => {};
              },
              onExit: (callback) => {
                exit = callback;
                // Logout needs no input, so the fake finishes it at once.
                if (input.args?.[1] === "logout") callback({ exitCode: 0, signal: null });
                return () => {};
              },
            };
          }),
      }),
    );
    const state = (predicate: (state: ProviderAuthState) => boolean) =>
      controller
        .subscribe("owner")
        .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
    return {
      controller,
      state,
      spawned,
      written,
      changed,
      data: (value: string) => data?.(value),
      exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
    };
  });

it.effect("signs in through Claude's own login with this instance's config directory", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(true);
    const flow = yield* h.controller.start("owner");
    yield* h.state((value) => value.interaction?.type === "terminal");
    assert.deepEqual(h.spawned[0], {
      shell: "/bin/claude",
      args: ["auth", "login", "--claudeai"],
      cwd: "/workspace",
      cols: 80,
      rows: 24,
      env: { CLAUDE_CONFIG_DIR: "/home/.claude_work" },
    });
    h.data("Paste code here if prompted > ");
    yield* h.state(
      (value) =>
        value.interaction?.type === "terminal" &&
        value.interaction.output.includes("Paste code here"),
    );
    yield* h.controller.respond!("owner", {
      instanceId,
      flowId: flow.flowId!,
      interactionId: "terminal",
      response: { type: "terminal", data: "the-code\r" },
    });
    assert.deepEqual(h.written, ["the-code\r"]);
    h.exit(0);
    yield* h.state((value) => value.phase === "succeeded");
    assert.deepEqual(h.changed, [true]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails when Claude still reports no login after the command exits", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(false);
    yield* h.controller.start("owner");
    yield* h.state((value) => value.interaction?.type === "terminal");
    h.exit(0);
    const failed = yield* h.state((value) => value.phase === "failed");
    assert.strictEqual(failed.message, "Not logged in");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("signs out with Claude's own logout", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(true);
    yield* h.controller.logout(Effect.void);
    assert.deepEqual(h.spawned[0]?.args, ["auth", "logout"]);
    assert.deepEqual(h.changed, [false]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/**
 * Fork (Owner): Sign in and Sign out for a Claude instance from Settings, so
 * a new Claude account never needs `claude auth login` typed into a terminal
 * on each machine. Runs Claude's own login in the in-app sign-in terminal with
 * this instance's CLAUDE_CONFIG_DIR: the user opens the printed link, signs in,
 * and pastes the code back. Credentials stay where Claude keeps them.
 */
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";

const TRANSCRIPT_LIMIT = 16_384;

export const makeClaudeAuth = Effect.fn("fork.makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  /** Resolved config directory; equal directories share one login. */
  readonly configDir: string;
  /** The instance's launch environment, already carrying its CLAUDE_CONFIG_DIR. */
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Refresh the snapshot; fail when a sign-in did not leave Claude authenticated. */
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void, ProviderSetupError>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });

  /** Run one `claude auth …` command, mirroring its terminal into the flow when given one. */
  const runClaude = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    context?: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty))
      return yield* failure("start", "Interactive sign-in is unavailable on this environment.");
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: options.binaryPath,
        args: [...args],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: options.environment,
      })
      .pipe(Effect.mapError((cause) => failure("start", "Could not start Claude.", cause)));
    const detachData = process.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-TRANSCRIPT_LIMIT));
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {
          /* Claude may already have exited. */
        }
      }),
    );
    if (context) {
      let transcript = "";
      let outputOffset = 0;
      const update = () =>
        context.setInteraction(
          { type: "terminal", id: "terminal", output: transcript, outputOffset },
          (response) =>
            response.type === "terminal"
              ? Effect.try({
                  try: () => {
                    if (response.size) process.resize(response.size.cols, response.size.rows);
                    if (response.data) process.write(response.data);
                  },
                  catch: () => failure("respond", "The Claude sign-in has already ended."),
                })
              : Effect.void,
        );
      yield* update();
      yield* Queue.take(output).pipe(
        Effect.flatMap((data) => {
          outputOffset += data.length;
          transcript = (transcript + data).slice(-TRANSCRIPT_LIMIT);
          return update();
        }),
        Effect.forever,
        Effect.forkScoped,
      );
    }
    return yield* Deferred.await(exited);
  });

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `claude:${options.configDir}` },
    methods: Effect.succeed([
      {
        id: "claudeai",
        name: "Claude subscription",
        description: "Sign in with your Claude Pro or Max account.",
        type: "terminal" as const,
      },
    ]),
    defaultMethodId: "claudeai",
    authenticate: (_methodId, context) =>
      Effect.gen(function* () {
        const exitCode = yield* runClaude(["auth", "login", "--claudeai"], context).pipe(
          Effect.scoped,
        );
        if (exitCode !== 0) return yield* failure("start", "Claude sign-in did not finish.");
        yield* context.verifying;
        yield* options.onChanged(true);
      }),
    logout: Effect.gen(function* () {
      const exitCode = yield* runClaude(["auth", "logout"]).pipe(Effect.scoped);
      if (exitCode !== 0) return yield* failure("logout", "Claude could not sign out.");
      yield* options.onChanged(false);
    }),
  });
});

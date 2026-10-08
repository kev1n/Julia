/**
 * Fork (Owner): Claude sign in and out from Settings, running Claude's own login in the sign-in
 * terminal with this instance's CLAUDE_CONFIG_DIR. The "token" method runs `claude setup-token`,
 * which stores nothing: the client saves the printed token as CLAUDE_CODE_OAUTH_TOKEN everywhere.
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

  /**
   * Run one `claude …` command, mirroring its terminal into the flow when given
   * one. With `holdAfterExit`, a successful run keeps its final output on screen
   * until the client sends an empty response, so the client is sure to see the
   * whole transcript.
   */
  const runClaude = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    context?: ProviderAuthFlow.ProviderAuthFlowContext,
    terminal: { readonly fixedCols?: number; readonly holdAfterExit?: boolean } = {},
  ) {
    if (Option.isNone(pty))
      return yield* failure("start", "Interactive sign-in is unavailable on this environment.");
    const exited = yield* Deferred.make<number>();
    // A promise, like Codex's callback, so the response returns before the flow ends.
    const confirmed = Promise.withResolvers<void>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: options.binaryPath,
        args: [...args],
        cwd: options.cwd,
        // A wide fixed terminal keeps a printed token on one line.
        cols: terminal.fixedCols ?? 80,
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
    if (!context) return yield* Deferred.await(exited);

    let transcript = "";
    let outputOffset = 0;
    const append = (data: string) => {
      outputOffset += data.length;
      transcript = (transcript + data).slice(-TRANSCRIPT_LIMIT);
    };
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) => {
          if (response.type !== "terminal") return Effect.void;
          if (!response.data && !response.size) return Effect.sync(() => confirmed.resolve());
          return Effect.try({
            try: () => {
              if (response.size && terminal.fixedCols === undefined)
                process.resize(response.size.cols, response.size.rows);
              if (response.data) process.write(response.data);
            },
            catch: () => failure("respond", "The Claude sign-in has already ended."),
          });
        },
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        append(data);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    const exitCode = yield* Deferred.await(exited);
    if (!terminal.holdAfterExit || exitCode !== 0) return exitCode;
    // The forwarder keeps publishing any output still queued meanwhile.
    yield* Effect.promise(() => confirmed.promise);
    return exitCode;
  });

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `claude:${options.configDir}` },
    methods: Effect.succeed([
      {
        id: "claudeai",
        name: "Sign in on this machine",
        description:
          "Uses your Claude Pro or Max account on this machine only. Other machines keep their own login.",
        type: "terminal" as const,
      },
      {
        id: "token",
        name: "Share login with connected machines",
        description:
          "Sign in once to create a subscription token, then save it on connected machines. Missing account slots are created. Offline machines are skipped; reconnect and save the token again to copy it there. This is a one-time copy, not continuous sync.",
        type: "terminal" as const,
      },
    ]),
    defaultMethodId: "claudeai",
    authenticate: Effect.fn("claudeAuth.authenticate")(function* (methodId, context) {
      if (methodId === "token") {
        const exitCode = yield* runClaude(["setup-token"], context, {
          fixedCols: 400,
          holdAfterExit: true,
        }).pipe(Effect.scoped);
        if (exitCode !== 0) return yield* failure("start", "Claude did not create a token.");
        return;
      }
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

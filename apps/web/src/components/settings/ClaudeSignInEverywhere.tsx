/**
 * Fork (Owner): signs one Claude account in on every connected machine with Claude's own login, so
 * each shows the account's email, plan and usage (a `setup-token` token does not). One sign-in
 * page per machine; each code is pasted back into that machine's row.
 */
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { readClaudeLoginUrl, withProviderSecret } from "./addProviderEverywhere.logic";

const SHARED_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

export interface SignInMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Why this machine cannot sign in now; null when it can. */
  readonly skipped: "offline" | "no permission" | null;
}

/**
 * Starts Claude's login for one instance on every machine. A machine missing
 * the instance gets it from the source machine's entry, and a shared token is
 * removed first because it would override the new login.
 */
export function useClaudeSignInEverywhere(
  sourceEnvironmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
) {
  const { environments } = useEnvironments();
  const commands = { reportFailure: false, reportDefect: false };
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, commands);
  const startProviderAuth = useAtomCommand(serverEnvironment.startProviderAuth, commands);

  const machines: ReadonlyArray<SignInMachine> = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    skipped:
      environment.connection.phase !== "connected" || !environment.serverConfig
        ? "offline"
        : !readEnvironmentScope(environment.environmentId, AuthProvidersManageScope)
          ? "no permission"
          : null,
  }));

  /** Resolves to an error message, or null once the machine's login has started. */
  const signIn = async (environmentId: EnvironmentId): Promise<string | null> => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    const source = environments.find((entry) => entry.environmentId === sourceEnvironmentId);
    const instances = environment?.serverConfig?.settings.providerInstances;
    if (!instances) return "This machine is offline.";
    const existing = instances[instanceId];
    const sourceInstance = source?.serverConfig?.settings.providerInstances[instanceId];
    let instance: ProviderInstanceConfig | undefined;
    if (!existing) {
      if (!sourceInstance) return "This account is missing on the source machine.";
      // Only the slot is copied; the source's secrets are redacted anyway.
      const { environment: _secrets, ...rest } = sourceInstance;
      instance = rest;
    } else if (existing.environment?.some((variable) => variable.name === SHARED_TOKEN)) {
      const { environment: variables, ...rest } = existing;
      const remaining = withProviderSecret(variables, SHARED_TOKEN, "");
      instance = remaining.length > 0 ? { ...rest, environment: remaining } : rest;
    }
    if (instance) {
      const saved = await mutateProviderInstance({
        environmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: existing ? "upsert" : "create",
            instanceId,
            instance,
          },
        },
      });
      if (saved._tag !== "Success") return "Could not prepare this account here.";
    }
    const started = await startProviderAuth({
      environmentId,
      input: { instanceId, methodId: "claudeai" },
    });
    return started._tag === "Success" ? null : "Could not start sign-in here.";
  };

  return { machines, signIn };
}

/** One row per machine; starts every reachable machine's login when it mounts. */
export function ClaudeSignInEverywherePanel({
  sourceEnvironmentId,
  instanceId,
  onClose,
}: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly onClose: () => void;
}) {
  const { machines, signIn } = useClaudeSignInEverywhere(sourceEnvironmentId, instanceId);
  // The machines this panel signs in, fixed when it opens so a machine that
  // reconnects later does not start a login nobody asked for.
  const [targets] = useState(() => machines);
  // Per machine: absent while its login starts, then null or the reason it could not.
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const started = useRef(false);

  const begin = (environmentId: EnvironmentId) =>
    void signIn(environmentId).then((error) =>
      setErrors((current) => ({ ...current, [environmentId]: error })),
    );
  const retry = (environmentId: EnvironmentId) => {
    setErrors((current) => {
      const next = { ...current };
      delete next[environmentId];
      return next;
    });
    begin(environmentId);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts sign-in on every machine once when the panel opens
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    for (const machine of targets) if (machine.skipped === null) begin(machine.environmentId);
  }, [begin, targets]);

  return (
    <div className="grid gap-2 py-2">
      <p className="text-xs text-muted-foreground">
        Open each machine&apos;s sign-in page, approve it, then paste the code it shows into that
        machine&apos;s row. Each machine keeps its own login.
      </p>
      {targets.map((machine) => (
        <MachineSignInRow
          key={machine.environmentId}
          machine={machine}
          instanceId={instanceId}
          startError={errors[machine.environmentId]}
          onRetry={() => retry(machine.environmentId)}
        />
      ))}
      <Button size="sm" variant="ghost-muted" className="w-fit" onClick={onClose}>
        Done
      </Button>
    </div>
  );
}

function MachineSignInRow({
  machine,
  instanceId,
  startError,
  onRetry,
}: {
  readonly machine: SignInMachine;
  readonly instanceId: ProviderInstanceId;
  /** Undefined while the login is starting, which hides the last flow's outcome. */
  readonly startError: string | null | undefined;
  readonly onRetry: () => void;
}) {
  const { environmentId } = machine;
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  );
  const commands = { reportFailure: false, reportDefect: false };
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commands);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const auth = query.data;
  const interaction = auth?.interaction;
  const url =
    auth?.phase === "waiting" && interaction?.type === "terminal"
      ? readClaudeLoginUrl(interaction.output)
      : null;

  // The desktop app can open every machine's page at once; a browser only
  // allows a tab per click, so the web build waits for the Open button.
  const openedFlow = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens each new sign-in page in the system browser on desktop
  useEffect(() => {
    if (!url || !auth?.flowId || !window.desktopBridge || openedFlow.current === auth.flowId)
      return;
    openedFlow.current = auth.flowId;
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => setError("Could not open the sign-in page. Use Open."));
  }, [auth?.flowId, url]);

  async function submit() {
    if (!auth?.flowId || !interaction || !code.trim()) return;
    setPending(true);
    setError(null);
    const result = await respond({
      environmentId,
      input: {
        instanceId,
        flowId: auth.flowId,
        interactionId: interaction.id,
        response: { type: "terminal", data: `${code.trim()}\r` },
      },
    });
    setPending(false);
    if (result._tag === "Success") setCode("");
    else setError("Could not send the code. Retry sign-in.");
  }

  const status = machine.skipped
    ? `Skipped (${machine.skipped}).`
    : startError
      ? startError
      : startError === undefined || !auth || auth.phase === "idle" || auth.phase === "starting"
        ? "Starting sign-in…"
        : auth.phase === "waiting"
          ? url
            ? "Open the sign-in page, then paste its code."
            : "Waiting for Claude…"
          : auth.phase === "verifying"
            ? "Checking your account…"
            : auth.phase === "succeeded"
              ? "Signed in."
              : (auth.message ?? (auth.phase === "cancelled" ? "Cancelled." : "Sign-in failed."));
  const canRetry =
    machine.skipped === null &&
    (typeof startError === "string" ||
      (startError === null && (auth?.phase === "failed" || auth?.phase === "cancelled")));

  return (
    <div className="grid gap-1.5 rounded-md border px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="font-medium">{machine.label}</span>
        <span role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
          {status}
        </span>
        {url ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void ensureLocalApi()
                .shell.openExternal(url)
                .catch(() => setError("Could not open the sign-in page."))
            }
          >
            Open
          </Button>
        ) : null}
        {canRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
        {auth?.flowId && (auth.phase === "waiting" || auth.phase === "starting") ? (
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() =>
              void cancel({ environmentId, input: { instanceId, flowId: auth.flowId! } })
            }
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {url ? (
        <form
          className="flex min-w-0 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            size="sm"
            aria-label={`Sign-in code for ${machine.label}`}
            placeholder="Paste code"
            autoComplete="off"
            value={code}
            disabled={pending}
            maxLength={4_096}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={pending || !code.trim()}>
            Submit
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

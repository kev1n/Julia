import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAuthRespondInput,
  ProviderAuthState,
  ProviderAuthResponse,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { lazy, Suspense, useRef, useState } from "react";
import { CopyIcon } from "lucide-react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { isWebUrl } from "../../browser/webUrl";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { useShareProviderSecret } from "./addProviderEverywhere";
import { ClaudeSignInEverywherePanel } from "./ClaudeSignInEverywhere";
import { useEnvironments } from "../../state/environments";
import { readClaudeSetupToken } from "./addProviderEverywhere.logic";
import { toastManager } from "../ui/toast";

const ProviderAuthTerminal = lazy(() => import("./ProviderAuthTerminal"));

const EVERYWHERE_METHOD = {
  id: "everywhere",
  name: msg("Sign in on every machine"),
  description: msg(
    "Signs in separately on this machine and each connected machine, so each keeps its own login and shows the account's email, plan and usage. Opens one sign-in page per machine; paste each page's code back here. Replaces a shared login token.",
  ),
};

/**
 * Claude only, and only with another machine to sign in on. Client-side: each
 * machine runs its ordinary "claudeai" login.
 */
export function offersSignInEverywhere(provider: ServerProvider, environmentCount: number) {
  return provider.driver === "claudeAgent" && environmentCount > 1;
}

export function ProviderAuthenticationSection({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  readOnly,
  everywhereOpen: everywhereOpenProp,
  onEverywhereOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
  /** Lets a parent such as the add-provider wizard open the every-machine panel. */
  readonly everywhereOpen?: boolean;
  readonly onEverywhereOpenChange?: (open: boolean) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerAuthState(target), messages);
  const commands = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commands);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commands);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commands);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commands);
  const [methodId, setMethodId] = useState("");
  const [draft, setDraft] = useState({ id: "", values: {} as Record<string, string> });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const terminalQueue = useRef<ProviderAuthRespondInput[]>([]);
  const terminalSending = useRef(false);
  const [everywhereOpenState, setEverywhereOpenState] = useState(false);
  const everywhereOpen = everywhereOpenProp ?? everywhereOpenState;
  const setEverywhereOpen = onEverywhereOpenChange ?? setEverywhereOpenState;
  const { environments } = useEnvironments();
  const auth = query.data;
  const interaction = auth?.interaction;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && auth?.phase === "succeeded");
  const isDiscovering =
    provider.driver === "acpRegistry" &&
    !active &&
    !signedIn &&
    !query.error &&
    auth?.methods === undefined;
  const needsExternalSetup =
    !active &&
    !signedIn &&
    (provider.setup?.canAuthenticate === false ||
      (provider.driver === "acpRegistry" && auth?.methods?.length === 0));
  const usesCredentials =
    provider.driver === "antigravity" &&
    (provider.auth.type === "gemini-api-key" || provider.auth.type === "agent-platform");
  const accountDescription = everywhereOpen
    ? gt("Signing in on every machine.")
    : active
      ? auth?.phase === "starting"
        ? (auth.message ?? (usesCredentials ? gt("Connecting…") : gt("Starting sign-in…")))
        : auth?.phase === "verifying"
          ? usesCredentials
            ? gt("Checking credentials and loading models…")
            : gt("Checking your account…")
          : interaction?.type === "terminal"
            ? gt("Complete sign-in in the terminal below.")
            : interaction?.type === "credentials"
              ? gt("Enter your credentials below.")
              : gt("Finish signing in in your browser.")
      : signedIn
        ? gt("Signed in.")
        : isDiscovering
          ? gt("Discovering sign-in methods…")
          : needsExternalSetup
            ? gt("No in-app sign-in advertised. Follow the provider's docs to finish setup.")
            : usesCredentials
              ? gt("Connect on {environment} to load models.", { environment: environmentLabel })
              : gt("Sign in on {environment}.", { environment: environmentLabel });
  const statusMessage = auth?.phase === "failed" ? auth.message : null;
  const disabled = readOnly || pending || query.error !== null || isDiscovering;
  // The default method whenever it is offered.
  const everywhereMethod = offersSignInEverywhere(provider, environments.length)
    ? {
        ...EVERYWHERE_METHOD,
        name: messages(EVERYWHERE_METHOD.name),
        description: messages(EVERYWHERE_METHOD.description),
      }
    : undefined;
  const defaultMethod =
    everywhereMethod ??
    (provider.driver === "claudeAgent"
      ? auth?.methods?.find((method) => method.id === "claudeai")
      : undefined);
  const everywhereSelected = everywhereMethod !== undefined && methodId === "";
  const selectedMethod = auth?.methods?.find((method) => method.id === methodId) ?? defaultMethod;
  const draftId = `${auth?.flowId ?? ""}:${interaction?.id ?? ""}`;
  const values = draft.id === draftId ? draft.values : {};
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : auth?.authorizationUrl;

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    let succeeded = false;
    try {
      const result = await command();
      if (result._tag === "Success") succeeded = true;
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? (thrownErrorMessage(failure, m) ?? failure.message)
            : gt("Provider sign-in failed. Try again."),
        );
      }
    } catch {
      setError(gt("Provider sign-in failed. Try again."));
    }
    pendingRef.current = false;
    setPending(false);
    return succeeded;
  }

  async function send(response: ProviderAuthResponse) {
    if (!auth?.flowId || !interaction) return false;
    return run(() =>
      respond({
        environmentId,
        input: { instanceId, flowId: auth.flowId!, interactionId: interaction.id, response },
      }),
    );
  }

  async function openBrowser() {
    if (!url || readOnly) return;
    if (!isWebUrl(url)) {
      setError(gt("This sign-in link is not a web address, so it was not opened."));
      return;
    }
    const requiresConsent = interaction?.type === "browser" && interaction.requiresConsent;
    // Reserve tabs before awaiting consent; browsers block later opens.
    const pending = requiresConsent && !window.desktopBridge ? window.open("", "_blank") : null;
    if (pending) pending.opener = null;
    try {
      if (requiresConsent && !(await send({ type: "browser", action: "accept" }))) {
        pending?.close();
        return;
      }
      if (pending) pending.location.href = url;
      else await ensureLocalApi().shell.openExternal(url);
      setError(null);
    } catch {
      pending?.close();
      setError(gt("Could not open the sign-in page. Copy the link and open it in your browser."));
    }
  }

  // Claude's "all machines" sign-in prints a token for ShareClaudeToken to save.
  const claudeToken =
    provider.driver === "claudeAgent" &&
    auth?.phase === "waiting" &&
    interaction?.type === "terminal" &&
    !readOnly
      ? readClaudeSetupToken(interaction.output)
      : null;

  function updateDraft(name: string, value: string) {
    setDraft({ id: draftId, values: { ...values, [name]: value } });
  }

  return (
    <SettingsRow
      title={gt("Account")}
      description={
        signedIn && !active && provider.auth.email?.trim() ? (
          <span>
            <T>
              Signed in as{" "}
              <RedactedSensitiveText
                key={provider.auth.email}
                value={provider.auth.email}
                ariaLabel={gt("Toggle account email visibility")}
                revealTooltip={gt("Click to reveal email")}
                hideTooltip={gt("Click to hide email")}
                className="max-w-full truncate"
              />
            </T>
          </span>
        ) : (
          <span role="status">{accountDescription}</span>
        )
      }
      status={
        statusMessage ? (
          <p role="status" className="[overflow-wrap:anywhere]">
            {statusMessage}
          </p>
        ) : undefined
      }
      control={
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {everywhereOpen ? null : !active &&
            (auth?.methods?.length ?? 0) + (everywhereMethod ? 1 : 0) > 1 ? (
            <Select
              value={auth?.methods?.some((method) => method.id === methodId) ? methodId : ""}
              disabled={disabled}
              onValueChange={(value) => setMethodId(value ?? "")}
            >
              <SelectTrigger
                size="sm"
                aria-label={gt("Sign-in method")}
                className={provider.driver === "claudeAgent" ? "w-72 max-w-full" : "w-44"}
              >
                <SelectValue>{selectedMethod?.name ?? gt("Provider default")}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">{defaultMethod?.name ?? gt("Provider default")}</SelectItem>
                {auth?.methods?.map((method) =>
                  method.id !== defaultMethod?.id ? (
                    <SelectItem key={method.id} value={method.id}>
                      {method.name}
                    </SelectItem>
                  ) : null,
                )}
              </SelectPopup>
            </Select>
          ) : null}
          {url && !everywhereOpen ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void openBrowser()}
              >
                <T>Open browser</T>
              </Button>
              <SharedTooltipTrigger
                render={
                  <Button
                    aria-label={gt("Copy sign-in link")}
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={disabled}
                    onClick={() => {
                      // Copy during the click to retain clipboard activation; consent must still be
                      // recorded before use.
                      const copied = writeTextToClipboard(url, {
                        target: "Provider sign-in link",
                        unavailableMessage: msg(
                          "Clipboard API is unavailable while copying Provider sign-in link.",
                        ),
                        failureMessage: msg(
                          "Failed to copy Provider sign-in link to the clipboard.",
                        ),
                      });
                      void (async () => {
                        await copied;
                        if (interaction?.type === "browser" && interaction.requiresConsent)
                          await send({ type: "browser", action: "accept" });
                      })().catch(() => setError(gt("Could not copy the sign-in link.")));
                    }}
                  >
                    <CopyIcon />
                  </Button>
                }
                label={
                  <>
                    <T>Copy sign-in link</T>
                  </>
                }
              />
            </>
          ) : null}
          {everywhereOpen ? null : (
            <>
              {needsExternalSetup && provider.setup?.documentationUrl ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <a href={provider.setup.documentationUrl} target="_blank" rel="noreferrer" />
                  }
                >
                  <T>Open docs</T>
                </Button>
              ) : active && auth?.flowId ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  aria-label={gt("Cancel sign-in")}
                  disabled={disabled}
                  onClick={() =>
                    void run(() =>
                      cancel({ environmentId, input: { instanceId, flowId: auth.flowId! } }),
                    )
                  }
                >
                  <T>Cancel</T>
                </Button>
              ) : !active && !needsExternalSetup && provider.setup?.canAuthenticate !== false ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || !provider.enabled || !provider.installed || !auth}
                  onClick={() =>
                    everywhereSelected
                      ? setEverywhereOpen(true)
                      : void run(() =>
                          start({
                            environmentId,
                            input: {
                              instanceId,
                              ...(methodId &&
                              auth?.methods?.some((method) => method.id === methodId)
                                ? { methodId }
                                : {}),
                            },
                          }),
                        )
                  }
                >
                  {signedIn
                    ? gt("Change account")
                    : auth?.phase === "failed" || auth?.phase === "cancelled"
                      ? usesCredentials
                        ? gt("Retry connection")
                        : gt("Retry sign-in")
                      : usesCredentials
                        ? gt("Connect")
                        : gt("Sign in")}
                </Button>
              ) : null}
              {!active &&
              signedIn &&
              (provider.auth.canLogout ?? provider.setup?.canAuthenticate) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || !auth}
                  onClick={() => {
                    void ensureLocalApi()
                      .dialogs.confirm(
                        gt(
                          "Sign out of {provider} on {environment}? This stops running threads that share this sign-in. Thread history is kept.",
                          {
                            provider: provider.displayName ?? provider.driver,
                            environment: environmentLabel,
                          },
                        ),
                      )
                      .then((confirmed) => {
                        if (confirmed) void run(() => logout(target));
                      });
                  }}
                >
                  <T>Sign out</T>
                </Button>
              ) : null}
            </>
          )}
        </div>
      }
    >
      {everywhereOpen ? (
        <ClaudeSignInEverywherePanel
          sourceEnvironmentId={environmentId}
          instanceId={instanceId}
          onClose={() => setEverywhereOpen(false)}
        />
      ) : !active && provider.driver === "claudeAgent" && selectedMethod?.description ? (
        <p className="py-2 text-xs text-muted-foreground">{selectedMethod.description}</p>
      ) : null}
      {!everywhereOpen &&
      (interaction?.type === "terminal" ||
        interaction?.type === "credentials" ||
        interaction?.type === "deviceCode" ||
        (url && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction)) ||
        error ||
        query.error) ? (
        <>
          {interaction?.type === "deviceCode" ? (
            <p className="py-2 text-sm text-muted-foreground">
              <T>
                Enter code{" "}
                <code className="select-all font-mono text-foreground">
                  <Var>{interaction.userCode}</Var>
                </code>{" "}
                in your browser.
              </T>
            </p>
          ) : null}
          {claudeToken && auth?.flowId ? (
            <ShareClaudeToken
              key={auth.flowId}
              environmentId={environmentId}
              instanceId={instanceId}
              flowId={auth.flowId}
              token={claudeToken}
            />
          ) : null}
          {interaction?.type === "terminal" ? (
            <div className="py-2">
              <Suspense
                fallback={
                  <p className="text-xs text-muted-foreground">
                    <T>Loading sign-in terminal…</T>
                  </p>
                }
              >
                <ProviderAuthTerminal
                  key={`${auth?.flowId}:${interaction.id}`}
                  output={interaction.output}
                  outputOffset={interaction.outputOffset}
                  onResponse={(response) => {
                    if (readOnly || !auth?.flowId) return;
                    for (
                      let offset = 0;
                      offset < Math.max(1, response.data.length);
                      offset += 4_096
                    ) {
                      terminalQueue.current.push({
                        instanceId,
                        flowId: auth.flowId,
                        interactionId: interaction.id,
                        response: {
                          ...response,
                          data: response.data.slice(offset, offset + 4_096),
                        },
                      });
                    }
                    if (terminalSending.current) return;
                    terminalSending.current = true;
                    void (async () => {
                      while (terminalQueue.current.length > 0) {
                        const input = terminalQueue.current.shift()!;
                        const result = await respond({ environmentId, input });
                        if (result._tag !== "Success") {
                          terminalQueue.current = [];
                          if (!isAtomCommandInterrupted(result))
                            setError(gt("The provider sign-in terminal is no longer available."));
                          break;
                        }
                      }
                    })()
                      .catch(() => {
                        terminalQueue.current = [];
                        setError(gt("Could not send input to the provider sign-in terminal."));
                      })
                      .finally(() => {
                        terminalSending.current = false;
                      });
                  }}
                />
              </Suspense>
            </div>
          ) : null}
          {interaction?.type === "credentials" ? (
            <form
              className="grid gap-2 py-2 text-sm leading-normal"
              onSubmit={(event) => {
                event.preventDefault();
                void send({ type: "credentials", values }).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            >
              {interaction.fields.map((field) => (
                <label key={field.name} className="grid gap-1">
                  {field.label}
                  <Input
                    size="sm"
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    value={values[field.name] ?? ""}
                    disabled={disabled}
                    maxLength={16_384}
                    onChange={(event) => updateDraft(field.name, event.target.value)}
                  />
                </label>
              ))}
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={disabled}
              >
                <T>Connect</T>
              </Button>
            </form>
          ) : null}
          {url && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction) ? (
            <form
              className="grid gap-2 py-2 text-sm leading-normal"
              onSubmit={(event) => {
                event.preventDefault();
                if (!auth?.flowId || !values.callback?.trim()) return;
                void run(() =>
                  complete({
                    environmentId,
                    input: { instanceId, flowId: auth.flowId!, callbackUrl: values.callback! },
                  }),
                ).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            >
              <label className="grid gap-1">
                <T>If the final localhost page does not load, paste its full URL here.</T>
                <Input
                  size="sm"
                  id={`provider-callback-${instanceId}`}
                  type="url"
                  autoComplete="off"
                  value={values.callback ?? ""}
                  disabled={disabled}
                  maxLength={16_384}
                  onChange={(event) => updateDraft("callback", event.target.value)}
                />
              </label>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={disabled || !values.callback?.trim()}
              >
                <T>Continue</T>
              </Button>
            </form>
          ) : null}
          {error || query.error ? (
            <p role="alert" className="py-2 text-xs text-destructive">
              {error ?? query.error}
            </p>
          ) : null}
        </>
      ) : null}
    </SettingsRow>
  );
}

/**
 * Saves the token Claude's "all machines" sign-in printed on every machine.
 * The server holds the flow open until the user chooses to save the login.
 */
function ShareClaudeToken(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly flowId: NonNullable<ProviderAuthState["flowId"]>;
  readonly token: string;
}) {
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, {
    reportFailure: false,
    reportDefect: false,
  });
  const shareProviderSecret = useShareProviderSecret(props.environmentId);
  const gt = useGT();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const { environmentId, instanceId, flowId, token } = props;
  async function save() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const confirmed = await respond({
        environmentId,
        input: {
          instanceId,
          flowId,
          interactionId: "terminal",
          response: { type: "terminal", data: "" },
        },
      });
      if (confirmed._tag !== "Success")
        throw new Error(gt("Could not finish token sign-in. Try again."));
      const result = await shareProviderSecret({
        instanceId,
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        value: token,
        includeSource: true,
      });
      if (result?.description)
        toastManager.add({
          type: result.failed.length > 0 ? "error" : "success",
          title: gt("Claude login sharing"),
          description: result.description,
        });
    } catch {
      const message = gt(
        "Could not save the Claude login. Retry sign-in or save the token in provider settings.",
      );
      setError(message);
      toastManager.add({ type: "error", title: gt("Claude login sharing"), description: message });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <div className="grid gap-2 py-2">
      <p className="text-xs text-muted-foreground">
        <T>
          Your login token is ready. Save it on this machine and other connected machines. Offline
          machines are skipped; this does not set up automatic sync.
        </T>
      </p>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void save()}>
        {pending ? gt("Saving login…") : gt("Save login to connected machines")}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

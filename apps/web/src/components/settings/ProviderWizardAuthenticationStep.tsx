import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { WizardFooter, WizardPanel } from "../ui/wizard";
import {
  offersSignInEverywhere,
  ProviderAuthenticationSection,
} from "./ProviderAuthenticationSection";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

export function ProviderWizardAuthenticationStep({
  environmentId,
  environmentLabel,
  instanceId,
  description,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly description?: string | undefined;
  readonly onFinish: () => void;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  );
  const auth = query.data;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const signedIn =
    provider?.auth.status === "authenticated" ||
    (provider?.auth.status === "unknown" && auth?.phase === "succeeded");
  const isDiscovering = !signedIn && !query.error && auth?.methods === undefined;
  const canAuthenticate = (auth?.methods?.length ?? 0) > 0;
  const { environments } = useEnvironments();
  const [everywhereOpen, setEverywhereOpen] = useState(false);
  // Signing in on this machine is only part of the job when other machines can
  // sign in too, so the footer leads there instead of closing the wizard.
  const offerEverywhere =
    provider !== undefined &&
    canAuthenticate &&
    !everywhereOpen &&
    offersSignInEverywhere(provider, environments.length);

  return (
    <>
      <WizardPanel className="min-h-72">
        {description ? <p className="mb-4 text-sm text-muted-foreground">{description}</p> : null}
        <SettingsGroup variant="plain">
          {provider && (canAuthenticate || signedIn) ? (
            <ProviderAuthenticationSection
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              instanceId={instanceId}
              provider={{
                ...provider,
                setup: {
                  ...provider.setup,
                  canInstall: provider.setup?.canInstall ?? false,
                  canAuthenticate,
                },
              }}
              readOnly={false}
              everywhereOpen={everywhereOpen}
              onEverywhereOpenChange={setEverywhereOpen}
            />
          ) : (
            <SettingsRow
              title="Account"
              description={
                isDiscovering
                  ? "Discovering sign-in methods…"
                  : (query.error ??
                    auth?.message ??
                    "No in-app sign-in advertised. Follow the provider's docs to finish setup.")
              }
              control={
                isDiscovering ? (
                  <Button disabled size="sm" variant="outline">
                    Sign in
                  </Button>
                ) : provider?.setup?.documentationUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    render={
                      <a href={provider.setup.documentationUrl} target="_blank" rel="noreferrer" />
                    }
                  >
                    Open docs
                  </Button>
                ) : undefined
              }
            />
          )}
        </SettingsGroup>
      </WizardPanel>
      <WizardFooter>
        <Button size="sm" variant="ghost-muted" disabled={active} onClick={onFinish}>
          {signedIn || everywhereOpen ? "Done" : "Skip for now"}
        </Button>
        {offerEverywhere ? (
          <Button size="sm" disabled={active} onClick={() => setEverywhereOpen(true)}>
            Sign in on every machine
          </Button>
        ) : null}
      </WizardFooter>
    </>
  );
}

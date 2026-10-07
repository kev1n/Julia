import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { describeFanOut, planProviderFanOut } from "./addProviderEverywhere.logic";
import { SettingsRow } from "./settingsLayout";

/** Copies a newly added provider to every other paired machine (see the logic module). */
export function useAddProviderEverywhere(sourceEnvironmentId: EnvironmentId) {
  const { environments } = useEnvironments();
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });
  // On by default so every new account lands on every machine unless turned off.
  const [enabled, setEnabled] = useState(true);
  const otherLabels = environments
    .filter((environment) => environment.environmentId !== sourceEnvironmentId)
    .map((environment) => environment.label);

  /** Returns a sentence for the success toast, or null when nothing else was attempted. */
  const addToOtherMachines = useCallback(
    async (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) => {
      if (!enabled || otherLabels.length === 0) return null;
      const plan = planProviderFanOut({
        sourceEnvironmentId,
        instanceId,
        candidates: environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          connected:
            environment.connection.phase === "connected" && environment.serverConfig !== null,
          canManageProviders: readEnvironmentScope(
            environment.environmentId,
            AuthProvidersManageScope,
          ),
          instanceIds: new Set(
            Object.keys(environment.serverConfig?.settings.providerInstances ?? {}),
          ),
        })),
      });
      const results = await Promise.all(
        plan.targets.map(async (target) => ({
          label: target.label,
          ok:
            (
              await mutateProviderInstance({
                environmentId: target.environmentId,
                input: {
                  patch: {},
                  providerInstanceMutation: { operation: "create", instanceId, instance },
                },
              })
            )._tag === "Success",
        })),
      );
      return describeFanOut(
        results.filter((result) => result.ok).map((result) => result.label),
        results.filter((result) => !result.ok).map((result) => result.label),
        plan.skipped,
      );
    },
    [enabled, environments, mutateProviderInstance, otherLabels.length, sourceEnvironmentId],
  );

  return { enabled, setEnabled, otherLabels, addToOtherMachines };
}

export function AddEverywhereRow({
  enabled,
  onEnabledChange,
  otherLabels,
}: {
  readonly enabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly otherLabels: ReadonlyArray<string>;
}) {
  if (otherLabels.length === 0) return null;
  return (
    <SettingsRow
      title="Add to all machines"
      description={`Also add it to ${otherLabels.join(", ")}. Each machine signs in separately.`}
      control={
        <Switch
          aria-label="Add to all machines"
          checked={enabled}
          onCheckedChange={(checked) => onEnabledChange(checked)}
        />
      }
    />
  );
}

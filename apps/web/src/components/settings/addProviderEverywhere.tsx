import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import {
  describeFanOut,
  planProviderFanOut,
  withProviderSecret,
} from "./addProviderEverywhere.logic";
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
  const addToOtherMachines = async (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  ) => {
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
  };

  return { enabled, setEnabled, otherLabels, addToOtherMachines };
}

/**
 * Saves one sign-in secret (Claude's subscription token, a Cursor API key) on
 * every paired machine, so the account signs in once instead of per machine.
 * A machine missing the instance gets it created from the source machine's
 * entry; clearing the value removes it everywhere it exists.
 */
export function useShareProviderSecret(sourceEnvironmentId: EnvironmentId | undefined) {
  const { environments } = useEnvironments();
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });

  /** Returns the per-machine outcome, or null when there is no other machine. */
  return async (input: {
    readonly instanceId: ProviderInstanceId;
    readonly name: string;
    readonly value: string;
    /** Also save it on the source machine, when the caller has not already. */
    readonly includeSource: boolean;
  }) => {
    if (sourceEnvironmentId === undefined) return null;
    const source = environments.find(
      (environment) => environment.environmentId === sourceEnvironmentId,
    );
    const sourceInstance = source?.serverConfig?.settings.providerInstances[input.instanceId];
    const removing = input.value.trim().length === 0;
    const candidates = environments.filter(
      (environment) => input.includeSource || environment.environmentId !== sourceEnvironmentId,
    );
    if (candidates.length === 0) return null;
    const added: Array<string> = [];
    const failed: Array<string> = [];
    const skipped: Array<{ label: string; reason: "offline" | "no-permission" }> = [];
    await Promise.all(
      candidates.map(async (environment) => {
        if (environment.connection.phase !== "connected" || !environment.serverConfig) {
          skipped.push({ label: environment.label, reason: "offline" });
          return;
        }
        if (!readEnvironmentScope(environment.environmentId, AuthProvidersManageScope)) {
          skipped.push({ label: environment.label, reason: "no-permission" });
          return;
        }
        const existing = environment.serverConfig.settings.providerInstances[input.instanceId];
        const base = existing ?? (removing ? undefined : sourceInstance);
        if (!base) {
          if (!removing) failed.push(environment.label);
          return;
        }
        const { environment: baseEnvironment, ...rest } = base;
        // A copied entry carries only this secret; the source's other secrets are redacted.
        const nextEnvironment = withProviderSecret(
          existing ? baseEnvironment : [],
          input.name,
          input.value,
        );
        const instance: ProviderInstanceConfig =
          nextEnvironment.length > 0 ? { ...rest, environment: nextEnvironment } : rest;
        const result = await mutateProviderInstance({
          environmentId: environment.environmentId,
          input: {
            patch: {},
            providerInstanceMutation: {
              operation: existing ? "upsert" : "create",
              instanceId: input.instanceId,
              instance,
            },
          },
        });
        (result._tag === "Success" ? added : failed).push(environment.label);
      }),
    );
    return {
      failed,
      description: describeFanOut(
        added,
        failed,
        skipped,
        removing
          ? { done: "Removed from", failed: "Could not remove from" }
          : { done: "Saved on", failed: "Could not save on" },
      ),
    };
  };
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
      title="Copy account slot to other machines"
      description={`Creates the same slot on connected machines: ${otherLabels.join(", ")}. Does not copy the login. Offline machines are skipped; there is no automatic sync.`}
      control={
        <Switch
          aria-label="Copy account slot to other machines"
          checked={enabled}
          onCheckedChange={(checked) => onEnabledChange(checked)}
        />
      }
    />
  );
}

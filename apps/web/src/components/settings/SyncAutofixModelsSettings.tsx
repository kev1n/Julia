/**
 * Fork (Owner): the "Fork sync auto-fix models" row. The daily sync's
 * auto-fix chat runs the first of these models whose provider has an account
 * with usage left (`apps/server/src/fork/autofixAccount.ts`).
 */
import type { ModelSelection } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { PlusIcon, XIcon } from "lucide-react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Whether the list is the shipped default (same models in the same order). */
export function syncAutofixModelsAreDefault(selections: ReadonlyArray<ModelSelection>): boolean {
  const defaults = DEFAULT_UNIFIED_SETTINGS.syncAutofixModelSelections;
  return (
    selections.length === defaults.length &&
    selections.every(
      (selection, index) =>
        selection.instanceId === defaults[index]?.instanceId &&
        selection.model === defaults[index]?.model,
    )
  );
}

export function SyncAutofixModelsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["syncAutofixModelSelections"]);
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const selections = settings.syncAutofixModelSelections;
  const defaults = DEFAULT_UNIFIED_SETTINGS.syncAutofixModelSelections;
  const isDefault = syncAutofixModelsAreDefault(selections);
  const save = (next: typeof selections) => updateSettings({ syncAutofixModelSelections: next });

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("sync-autofix-models")}
      description="When the fork's daily sync fails, its auto-fix chat runs the first of these models whose provider has an account with usage left, on that provider's freest account."
      settingKeys={["syncAutofixModelSelections"]}
      mixed={mixed}
      resetAction={
        !mixed && !isDefault ? (
          <SettingResetButton label="auto-fix models" onClick={() => save(defaults)} />
        ) : null
      }
      control={
        <Button
          size="compact"
          variant="outline"
          disabled={providers.length === 0}
          onClick={() => {
            const fallback = resolveAppModelSelectionState(settings, providers);
            save([...selections, createModelSelection(fallback.instanceId, fallback.model)]);
          }}
        >
          <PlusIcon /> Add model
        </Button>
      }
    >
      {mixed ? null : (
        <ol className="flex flex-col items-end gap-2 pb-3.5">
          {selections.map((selection, index) => (
            <li key={`${index}:${selection.instanceId}:${selection.model}`} className="flex gap-1">
              <ProviderModelPicker
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  selection.instanceId,
                  selection.model,
                )}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel={`Auto-fix model ${index + 1}`}
                getModelDisabledReason={disabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = disabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: "Auto-fix model not saved",
                      description: reason,
                    });
                    return;
                  }
                  save(
                    selections.map((current, at) =>
                      at === index ? createModelSelection(instanceId, model) : current,
                    ),
                  );
                }}
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove auto-fix model ${index + 1}`}
                onClick={() => save(selections.filter((_, at) => at !== index))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ol>
      )}
    </SettingsRow>
  );
}

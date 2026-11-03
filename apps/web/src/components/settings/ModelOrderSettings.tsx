/**
 * Fork: ordered model lists in Settings > General; the server runs the first with usage
 * left: the sync's auto-fix chat (`apps/server/src/fork/autofixAccount.ts`) and limited threads
 * (`apps/server/src/fork/limitFailover.ts`).
 */
import type { ModelSelection } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { PlusIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { providerInstanceEntriesFor } from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { ScopedSwitch } from "./ScopedSwitch";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type ModelOrderKey = "syncAutofixModelSelections" | "limitFailoverModelSelections";

/** Whether the list is the shipped default (same models in the same order). */
export function modelOrderIsDefault(
  key: ModelOrderKey,
  selections: ReadonlyArray<ModelSelection>,
): boolean {
  const defaults = DEFAULT_UNIFIED_SETTINGS[key];
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
  return (
    <ModelOrderRow
      settingKey="syncAutofixModelSelections"
      searchId="sync-autofix-models"
      description="When the fork's daily sync fails, its auto-fix chat runs the first of these models whose provider has an account with usage left, on that provider's freest account."
      modelLabel="Auto-fix model"
    />
  );
}

export function LimitFailoverRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const enabled = settings.continueLimitedThreadsElsewhere;
  return (
    <ModelOrderRow
      settingKey="limitFailoverModelSelections"
      searchId="limit-failover"
      description="When a turn stops on a usage limit, fork the thread into a new tab and continue there on the first of these models whose provider has another account with usage left. With none left, auto-resume and snooze apply."
      modelLabel="Fallback model"
      listHidden={!enabled}
      toggle={
        <ScopedSwitch
          settingKeys={["continueLimitedThreadsElsewhere"]}
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({ continueLimitedThreadsElsewhere: Boolean(checked) })
          }
          aria-label="Continue limited threads on another account"
        />
      }
    />
  );
}

// Rows have no id and may repeat a model, so the nth copy of a model keys as `<model>:<n>`.
function keyedRows(selections: ReadonlyArray<ModelSelection>) {
  const seen = new Map<string, number>();
  return selections.map((selection, index) => {
    const id = `${selection.instanceId}:${selection.model}`;
    const copy = seen.get(id) ?? 0;
    seen.set(id, copy + 1);
    return { selection, index, key: `${id}:${copy}` };
  });
}

function ModelOrderRow({
  settingKey,
  searchId,
  description,
  modelLabel,
  toggle,
  listHidden = false,
}: {
  settingKey: ModelOrderKey;
  searchId: SettingsSearchItemId;
  description: string;
  /** Names one entry, as "<modelLabel> 2", for its picker and remove button. */
  modelLabel: string;
  toggle?: ReactNode;
  listHidden?: boolean;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, target } = useSettingsScope();
  const mixed = useScopedSettingsMixed([settingKey]);
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    target?.projectId ?? null,
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const selections = settings[settingKey];
  const defaults = DEFAULT_UNIFIED_SETTINGS[settingKey];
  const isDefault = modelOrderIsDefault(settingKey, selections);
  const save = (next: typeof selections) => updateSettings({ [settingKey]: next });

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting(searchId)}
      description={description}
      settingKeys={[settingKey]}
      mixed={mixed}
      resetAction={
        !mixed && !isDefault ? (
          <SettingResetButton
            label={`${modelLabel.toLowerCase()}s`}
            onClick={() => save(defaults)}
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          {toggle}
          <Button
            size="compact"
            variant="outline"
            disabled={providers.length === 0 || listHidden}
            onClick={() => {
              const fallback = resolveAppModelSelectionState(settings, providers);
              save([...selections, createModelSelection(fallback.instanceId, fallback.model)]);
            }}
          >
            <PlusIcon /> Add model
          </Button>
        </div>
      }
    >
      {mixed || listHidden ? null : (
        <ol className="flex flex-col items-end gap-2 pb-3.5">
          {keyedRows(selections).map(({ selection, index, key }) => (
            <li key={key} className="flex gap-1">
              <ProviderModelPicker
                environmentId={environment?.environmentId ?? null}
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
                triggerAriaLabel={`${modelLabel} ${index + 1}`}
                getModelDisabledReason={disabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = disabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: `${modelLabel} not saved`,
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
                aria-label={`Remove ${modelLabel.toLowerCase()} ${index + 1}`}
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

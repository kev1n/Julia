import {
  getPromptControlledTraits,
  getTraitSelectChange,
} from "@t3tools/client-runtime/model-traits";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { Toolbar } from "../../components/ui/Toolbar";
import * as Dialog from "../../components/ui/Dialog";
import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
} from "@t3tools/shared/serverSettings";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
  ScopedThreadRef,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import {
  groupModelSubscriptions,
  defaultModelPriority,
  type ModelSubscriptionGroup,
} from "@t3tools/shared/modelSubscriptions";
import {
  useNavigation,
  useRoute,
  type RouteProp,
  type StaticScreenProps,
} from "@react-navigation/native";
import { type NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform, Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { IconButton } from "../../components/ui/IconButton";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { accountLimitSummary } from "../../../../web/src/fork/usageByAccount/accountSummary";
import { cn } from "../../lib/cn";
import {
  buildModelOptions,
  groupByProvider,
  type ModelOption,
  type ProviderGroup,
} from "../../lib/modelOptions";
import { applyProviderOptionSelection } from "../../lib/providerOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { ChatGptSharingStatus } from "./ChatGptSharingStatus";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentQuery } from "../../state/query";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadReportedModelSelection } from "../../state/entities";
import {
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
  useComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { activeComposerDraftKey, useQueuedRunEdit } from "../../state/queued-run-edit";
import { updateThreadDraftModelSelection } from "../../state/use-thread-composer-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { threadAllowsProviderSwitch } from "../../state/thread-provider-switching";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { ScreenContent } from "../../components/ui/ScreenContent";
import {
  createProviderCatalogRefreshRunner,
  providerCatalogRefreshError,
} from "./provider-catalog-refresh";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";
import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { ThreadMachineChoices, ThreadMachineRow } from "../../fork/ThreadMachinePicker";
import { ModelRow, ChoiceRow } from "./ThreadSettingsRows";
import {
  compatibleRuntimeModeForChoices,
  runtimeModeChoicesForSupportedModes,
  selectableChoices,
} from "./thread-settings-options";
import {
  canCommitPendingModel,
  modelFavoriteKey,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
} from "./thread-settings-sheet-state";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";

/**
 * Keep measured row changes stable, but let catalog mutations use the list's
 * native bounds so a filtered catalog that underflows returns to the top.
 */
const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);
const THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_OPTION_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_OPTION_EXIT_TRANSITION = FadeOut.duration(100);
const THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(
  Platform.OS,
  Platform.Version,
);
const EMPTY_MODEL_FAVORITES: ReadonlyArray<{
  readonly provider: ProviderInstanceId;
  readonly model: string;
}> = [];
const FAVORITES_PROVIDER_FILTER = "@favorites";
// Servers that predate `migrateModelPreferences` drop it and keep reporting null favorites.
const attemptedMigrationGenerations = new Map<EnvironmentId, number>();
const ALL_MODELS_FILTER = "@all-models";
/** The model's chosen subscription stays visible while alternatives are folded. */
function SubscriptionDisclosure(props: {
  readonly option: ModelOption;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly hasCapacity: boolean;
  readonly count: number;
  readonly onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Subscriptions for ${props.option.label}, ${props.count} accounts`}
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onToggle}
      className="mx-4 mb-2 min-h-14 flex-row items-center gap-2 rounded-b-2xl bg-grouped-card px-4 pb-2 active:bg-subtle"
    >
      <ProviderIcon
        iconUrl={props.option.providerIconUrl}
        provider={props.option.providerDriver}
        size={15}
      />
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.option.providerLabel} ·{" "}
          {props.selected ? "Selected" : props.hasCapacity ? "Auto" : "No capacity"}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {props.option.providerDetail ?? "Usage unavailable"}
        </Text>
      </View>
      <SymbolView
        name={props.expanded ? "chevron.up" : "chevron.down"}
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
    </Pressable>
  );
}

function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onPress: () => void;
  readonly isLast?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "min-h-11 flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle android:min-h-14",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
    </Pressable>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly valueLabel?: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly isLast?: boolean;
}) {
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center justify-between bg-grouped-card px-4 py-1",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-row items-center gap-2">
        {props.valueLabel ? (
          <Text className="text-sm text-foreground-muted">{props.valueLabel}</Text>
        ) : null}
        <ThemedSwitch
          accessibilityLabel={props.label}
          onValueChange={props.onValueChange}
          value={props.value}
        />
      </View>
    </View>
  );
}

type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" }
  | { readonly kind: "machine" };

type ThreadSettingsSessionProps = {
  readonly threadRef?: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly lockedProviderInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
};

/** The composer draft the sheet edits: the thread's own, or a queued message being edited. */
export type ExistingThreadSettingsRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftKey: string;
};

type ThreadSettingsSessionValue = {
  readonly threadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesLoaded: boolean;
  readonly toggleFavorite: (option: ModelOption) => void;
  readonly toggleHidden: (option: ModelOption) => void;
  readonly pendingHiddenKeys: ReadonlySet<string>;
  readonly manageHidden: boolean;
  readonly setManageHidden: (value: boolean) => void;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModeChoices: ReturnType<typeof runtimeModeChoicesForSupportedModes>;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly promptTraits: ReturnType<typeof getPromptControlledTraits>;
  readonly displayedModelSelection: ModelSelection | null;
  readonly reportedModelSelection: ModelSelection | null;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly pendingModel: ModelOption | null;
  readonly providerFilter: string | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
  readonly applyOptionChange: (id: string, value: string | boolean) => void;
  readonly commitPendingModel: () => boolean;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly pressModel: (option: ModelOption) => void;
  readonly setProviderFilter: (providerKey: string | null) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setShowLegacy: (showLegacy: boolean) => void;
  readonly toggleProvider: (providerKey: string) => void;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const registry = use(RegistryContext);
  const { onSelectModel, onUpdateOptionSelections } = props;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const config = props.environmentId ? configs.get(props.environmentId) : undefined;
  const settings = config?.settings;
  const connection = useEnvironmentQuery(
    props.environmentId ? environmentCatalog.stateAtom(props.environmentId) : null,
  ).data;
  const connectionGeneration = connection?.phase === "connected" ? connection.generation : null;
  const [manageHidden, setManageHidden] = useState(false);
  const pendingHidden = useRef(new Set<string>());
  const pendingFavorites = useRef(
    new Map<string, { favorite: boolean; settings: ServerSettings; pending: boolean }>(),
  );
  const [pendingHiddenKeys, setPendingHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const providerGroups =
    manageHidden && config
      ? groupByProvider(
          buildModelOptions(
            config,
            props.selectedModel,
            props.lockedProviderInstanceId,
            props.projectId,
            true,
          ),
        )
      : props.providerGroups;
  const legacyFavorites = AsyncResult.isSuccess(preferences)
    ? (preferences.value.modelFavorites ?? EMPTY_MODEL_FAVORITES)
    : EMPTY_MODEL_FAVORITES;
  const favoritesLoaded =
    settings !== undefined && (settings.favorites !== null || AsyncResult.isSuccess(preferences));
  const modelFavorites = resolveModelPreferences(settings ?? DEFAULT_SERVER_SETTINGS, {
    favorites: legacyFavorites,
  }).favorites;
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, "model favorites update");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the one-time legacy model favorites migration to server settings once per connection
  useEffect(() => {
    if (
      !props.environmentId ||
      !settings ||
      !AsyncResult.isSuccess(preferences) ||
      connectionGeneration === null ||
      attemptedMigrationGenerations.get(props.environmentId) === connectionGeneration
    )
      return;
    const patch = modelPreferencesMigrationPatch(settings, { favorites: legacyFavorites });
    if (!patch) return;
    attemptedMigrationGenerations.set(props.environmentId, connectionGeneration);
    void saveSettings({ environmentId: props.environmentId, input: { patch } });
  }, [
    connectionGeneration,
    legacyFavorites,
    preferences,
    props.environmentId,
    saveSettings,
    settings,
  ]);
  const favoriteKeys = new Set(
    modelFavorites.map((favorite) => modelFavoriteKey(favorite.provider, favorite.model)),
  );
  const toggleFavorite = async (option: ModelOption) => {
    const environmentId = props.environmentId;
    if (!favoritesLoaded || !environmentId) return;
    const currentSettings = registry.get(environmentServerConfigsAtom).get(environmentId)?.settings;
    if (!currentSettings) return;
    const favorites = resolveModelPreferences(currentSettings, {
      favorites: legacyFavorites,
    }).favorites;
    // Fork: a favorite covers every account that offers the same model.
    const compatible = providerGroups
      .flatMap((group) => group.models)
      .filter(
        (model) =>
          model.providerDriver === option.providerDriver &&
          model.selection.model === option.selection.model &&
          (option.providerDriver !== "acpRegistry" || model.providerKey === option.providerKey),
      );
    const targets = compatible.some((model) => model.key === option.key)
      ? compatible
      : [...compatible, option];
    const key = JSON.stringify([
      environmentId,
      option.selection.instanceId,
      option.selection.model,
    ]);
    const previous = pendingFavorites.current.get(key);
    const previousFavorite =
      previous && (previous.pending || previous.settings.favorites === currentSettings.favorites)
        ? previous.favorite
        : favorites.some((favorite) =>
            targets.some(
              (target) =>
                favorite.provider === target.selection.instanceId &&
                favorite.model === target.selection.model,
            ),
          );
    const pending = { favorite: !previousFavorite, settings: currentSettings, pending: true };
    pendingFavorites.current.set(key, pending);
    void Haptics.selectionAsync();
    const result = await saveSettings({
      environmentId: environmentId,
      input: {
        patch: {
          setModelFavorites: targets.map((target) => ({
            provider: target.selection.instanceId,
            model: target.selection.model,
            favorite: pending.favorite,
          })),
          ...(currentSettings.favorites === null ? { migrateModelPreferences: { favorites } } : {}),
        },
      },
    });
    if (
      AsyncResult.isSuccess(result) &&
      registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
        currentSettings.favorites
    ) {
      pending.pending = false;
    }
    if (pending.pending && pendingFavorites.current.get(key) === pending) {
      if (
        previous &&
        !previous.pending &&
        registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
          previous.settings.favorites
      ) {
        pendingFavorites.current.set(key, previous);
      } else {
        pendingFavorites.current.delete(key);
      }
    }
  };
  const toggleHidden = (option: ModelOption) => {
    if (
      !settings ||
      !props.environmentId ||
      !option.canHide ||
      pendingHidden.current.has(option.key)
    )
      return;
    pendingHidden.current.add(option.key);
    setPendingHiddenKeys(new Set(pendingHidden.current));
    void Haptics.selectionAsync();
    void saveSettings({
      environmentId: props.environmentId,
      input: {
        patch: {
          setModelsHidden: [
            {
              provider: option.selection.instanceId,
              model: option.selection.model,
              hidden: !option.isHidden,
            },
          ],
        },
      },
    }).then(() => {
      pendingHidden.current.delete(option.key);
      setPendingHiddenKeys(new Set(pendingHidden.current));
    });
  };
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const displayedPrompt = pendingModel ? (pendingPrompt ?? props.prompt) : props.prompt;

  const isApplied = (option: ModelOption) =>
    option.selection.instanceId === props.selectedModel?.instanceId &&
    option.selection.model === props.selectedModel.model;
  const isDisplayed = (option: ModelOption) =>
    pendingModel ? option.key === pendingModel.key : isApplied(option);

  const displayedDescriptors = pendingModel
    ? pendingModel.capabilities
      ? resolveProviderOptionDescriptors({
          capabilities: pendingModel.capabilities,
          selections: pendingModel.selection.options,
        })
      : []
    : props.optionDescriptors;
  const promptTraits = getPromptControlledTraits(displayedDescriptors, displayedPrompt);
  const displayedModel =
    pendingModel ??
    providerGroups.flatMap((group) => group.models).find((option) => isApplied(option)) ??
    null;
  const runtimeModeChoices = runtimeModeChoicesForSupportedModes(
    displayedModel?.supportedRuntimeModes,
  );
  const compatibleRuntimeMode = compatibleRuntimeModeForChoices(
    props.runtimeMode,
    runtimeModeChoices,
  );

  const hasLegacyModels = providerGroups.some((group) =>
    group.models.some((model) => model.isLegacy),
  );
  const commitPendingModel = () => {
    if (pendingModel) {
      if (pendingModel.isUnavailable || !canCommitPendingModel(pendingModel, providerGroups)) {
        Dialog.alert(
          "Model unavailable",
          "Set up this provider on web or desktop, or select another model.",
        );
        return false;
      }
      void Haptics.selectionAsync();
      onSelectModel(pendingModel);
      if (pendingPrompt !== null && pendingPrompt !== props.prompt) {
        props.onPromptChange(pendingPrompt);
      }
    }
    return true;
  };

  const applyOptionChange = (id: string, value: string | boolean) => {
    const descriptor = displayedDescriptors.find((entry) => entry.id === id);
    const change =
      descriptor?.type === "select" && typeof value === "string"
        ? getTraitSelectChange(
            { ...promptTraits, descriptors: displayedDescriptors },
            descriptor,
            displayedPrompt,
            value,
          )
        : null;
    if (descriptor?.type === "select") {
      if (!change) return;
      if (change.prompt !== displayedPrompt) {
        if (pendingModel) {
          setPendingPrompt(change.prompt);
        } else {
          props.onPromptChange(change.prompt);
        }
      }
      if (!("modelOptions" in change)) return;
    }
    const next =
      change && "modelOptions" in change
        ? (change.modelOptions ?? [])
        : applyProviderOptionSelection(displayedDescriptors, { id, value });
    if (!next) {
      return;
    }
    if (pendingModel) {
      rememberModelOptions(pendingModel.selection.instanceId, pendingModel.selection.model, next);
      setPendingModel({
        ...pendingModel,
        selection: { ...pendingModel.selection, options: next },
      });
    } else {
      onUpdateOptionSelections(next);
    }
  };

  const toggleProvider = (providerKey: string) => {
    setProviderExpansionOverrides((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  };

  const pressModel = (option: ModelOption) => {
    void Haptics.selectionAsync();
    if (isApplied(option) || option.key !== pendingModel?.key) {
      setPendingPrompt(null);
    }
    setPendingModel((current) =>
      pendingModelAfterPress({
        current,
        pressed: option,
        pressedIsApplied: isApplied(option),
        restoreSelection: props.restoreSelection,
      }),
    );
  };

  const value = {
    threadRef: props.threadRef ?? null,
    environmentId: props.environmentId,
    providerInstanceId: props.providerInstanceId,
    providerGroups,
    manageHidden,
    setManageHidden,
    toggleHidden,
    pendingHiddenKeys,
    runtimeMode: compatibleRuntimeMode,
    runtimeModeChoices,
    onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    displayedDescriptors,
    promptTraits,
    displayedModelSelection: pendingModel?.selection ?? props.selectedModel,
    reportedModelSelection: pendingModel ? null : (props.reportedModelSelection ?? null),
    favoriteKeys,
    favoritesLoaded,
    providerExpansionOverrides,
    hasLegacyModels,
    pendingModel,
    providerFilter,
    searchQuery,
    showLegacy: showLegacyToggle,
    applyOptionChange,
    commitPendingModel,
    isApplied,
    isDisplayed,
    pressModel,
    setProviderFilter,
    setSearchQuery,
    setShowLegacy: setShowLegacyToggle,
    toggleProvider,
    toggleFavorite,
  } satisfies ThreadSettingsSessionValue;

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);
  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }
  return value;
}

type ThreadSettingsCatalogItem =
  | {
      readonly kind: "model";
      readonly key: string;
      readonly group: ModelSubscriptionGroup<ModelOption>;
      readonly option: ModelOption;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "subscription";
      readonly key: string;
      readonly option: ModelOption;
      readonly recommended: boolean;
      readonly isLast: boolean;
    }
  | { readonly kind: "notice"; readonly key: string; readonly text: string }
  | { readonly kind: "empty"; readonly key: "empty" }
  | { readonly kind: "options"; readonly key: "options" };

function ThreadSettingsModelListRow(props: {
  readonly group: ModelSubscriptionGroup<ModelOption>;
  readonly option: ModelOption;
  readonly expanded: boolean;
}) {
  const session = useThreadSettingsSession();
  const selected = props.group.subscriptions.some((subscription) =>
    session.isDisplayed(subscription.value),
  );
  const isFavorite = props.group.subscriptions.some((subscription) =>
    session.favoriteKeys.has(subscription.value.key),
  );
  return (
    <>
      <ModelRow
        isFirst
        isLast={false}
        option={props.option}
        selected={selected}
        onPress={() => session.pressModel(props.option)}
        isFavorite={isFavorite}
        favoritesLoaded={session.favoritesLoaded}
        onToggleFavorite={() => session.toggleFavorite(props.option)}
        onToggleHidden={
          session.manageHidden && props.option.canHide
            ? () => {
                // Hiding a model hides it on every account that offers it.
                for (const subscription of props.group.subscriptions) {
                  if (
                    subscription.value.canHide &&
                    subscription.value.isHidden === props.option.isHidden
                  ) {
                    session.toggleHidden(subscription.value);
                  }
                }
              }
            : undefined
        }
        hiddenUpdatePending={props.group.subscriptions.some((subscription) =>
          session.pendingHiddenKeys.has(subscription.value.key),
        )}
      />
      <SubscriptionDisclosure
        option={props.option}
        expanded={props.expanded}
        selected={selected}
        hasCapacity={props.group.recommended !== null}
        count={props.group.subscriptions.length}
        onToggle={() => session.toggleProvider(props.group.key)}
      />
    </>
  );
}

function ThreadSettingsSubscriptionRow(props: {
  readonly option: ModelOption;
  readonly recommended: boolean;
  readonly isLast: boolean;
}) {
  const session = useThreadSettingsSession();
  return (
    <View className="mx-4 overflow-hidden rounded-xl">
      <ChoiceRow
        label={`${props.option.providerLabel}${props.recommended ? " · Recommended" : ""}`}
        description={props.option.providerDetail ?? "Usage unavailable"}
        selected={session.isDisplayed(props.option)}
        disabled={props.option.isUnavailable}
        onPress={() => session.pressModel(props.option)}
        isLast={props.isLast}
      />
    </View>
  );
}

function useThreadSettingsCatalogItems(
  session: ThreadSettingsSessionValue,
): ReadonlyArray<ThreadSettingsCatalogItem> {
  const {
    providerGroups,
    favoriteKeys,
    providerFilter,
    showLegacy,
    searchQuery,
    isDisplayed,
    providerExpansionOverrides,
    manageHidden,
  } = session;
  const configs = useAtomValue(environmentServerConfigsAtom);
  const providers = session.environmentId
    ? configs.get(session.environmentId)?.providers
    : undefined;
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a clock that re-renders account resets every minute
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const options = providerGroups.flatMap((group) => group.models);
  const groups = groupModelSubscriptions(
    options.map((option) => {
      const provider = providers?.find(
        (candidate) => candidate.instanceId === option.selection.instanceId,
      );
      const available =
        !option.isUnavailable &&
        (!provider ||
          (provider.enabled &&
            provider.installed &&
            provider.status === "ready" &&
            provider.availability !== "unavailable" &&
            provider.auth.status !== "unauthenticated"));
      return {
        instanceId: option.selection.instanceId,
        catalog:
          option.providerDriver === "acpRegistry"
            ? `acpRegistry:${option.providerKey}`
            : option.providerDriver,
        model: option.selection.model,
        available,
        usageLimits: provider?.usageLimits ?? option.usageLimits,
        value: {
          ...option,
          isUnavailable: !available,
          providerDetail: provider
            ? (accountLimitSummary(provider, now) ?? undefined)
            : option.providerDetail,
        },
      };
    }),
    now,
  );
  const isFavorite = (group: (typeof groups)[number]) =>
    group.subscriptions.some((subscription) => favoriteKeys.has(subscription.value.key));
  const hasFavorites = groups.some(isFavorite);
  const firstByCatalog = new Set<string>();
  const searching = searchQuery.trim().length > 0;
  // Favorites list only selectable models, so it never explains gated ones.
  // Accounts of one provider share a notice, so each text appears once.
  const notices = new Map<string, ThreadSettingsCatalogItem>();
  if (providerFilter !== FAVORITES_PROVIDER_FILTER) {
    for (const group of providerGroups) {
      if (
        !group.updateRequired ||
        (providerFilter !== null &&
          providerFilter !== ALL_MODELS_FILTER &&
          group.providerKey !== providerFilter)
      )
        continue;
      const text = formatProviderUpdateRequiredNotice(group.updateRequired, searchQuery);
      if (text && !notices.has(text)) {
        notices.set(text, { kind: "notice", key: `notice:${group.providerKey}`, text });
      }
    }
  }
  const modelItems = [...groups]
    .sort((a, b) => {
      const firstA = a.subscriptions[0]!;
      const firstB = b.subscriptions[0]!;
      return (
        defaultModelPriority(firstA.catalog, firstA.model) -
        defaultModelPriority(firstB.catalog, firstB.model)
      );
    })
    .flatMap((group): ThreadSettingsCatalogItem[] => {
      const first = group.subscriptions[0]!;
      const current = group.subscriptions.some((subscription) => !subscription.value.isLegacy);
      const isFirst = !firstByCatalog.has(first.catalog) && current;
      if (current) firstByCatalog.add(first.catalog);
      const selected = group.subscriptions.some((subscription) => isDisplayed(subscription.value));
      const favorite = isFavorite(group);
      const preferred = defaultModelPriority(first.catalog, first.model) < 3;
      const defaultModel =
        preferred ||
        isFirst ||
        group.subscriptions.some((subscription) => subscription.value.isDefault);
      if (
        providerFilter !== null &&
        providerFilter !== FAVORITES_PROVIDER_FILTER &&
        providerFilter !== ALL_MODELS_FILTER &&
        !group.subscriptions.some(
          (subscription) => subscription.value.providerKey === providerFilter,
        )
      )
        return [];
      if (providerFilter === FAVORITES_PROVIDER_FILTER && !favorite) return [];
      if (
        !searching &&
        !manageHidden &&
        providerFilter === null &&
        !selected &&
        !(preferred || (hasFavorites ? favorite : defaultModel))
      )
        return [];
      if (!showLegacy && !manageHidden && !current && !selected && !favorite && !searching)
        return [];
      if (
        !group.subscriptions.some((subscription) =>
          modelMatchesCatalogQuery({
            model: subscription.value,
            providerLabel: subscription.value.providerLabel,
            query: searchQuery,
          }),
        )
      )
        return [];
      const choice =
        group.subscriptions.find((subscription) => isDisplayed(subscription.value)) ??
        group.recommended ??
        first;
      const expanded = providerExpansionOverrides.has(group.key);
      return [
        { kind: "model", key: `group:${group.key}`, group, option: choice.value, expanded },
        ...(expanded
          ? group.subscriptions.map((subscription, index) => ({
              kind: "subscription" as const,
              key: `account:${subscription.value.key}`,
              option: subscription.value,
              recommended: group.recommended === subscription,
              isLast: index === group.subscriptions.length - 1,
            }))
          : []),
      ];
    });
  return [...modelItems, ...notices.values()];
}

function ThreadSettingsOptionsItem(props: {
  readonly animationsReady: boolean;
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const selectedProvider = session.environmentId
    ? (configs
        .get(session.environmentId)
        ?.providers.find((provider) => provider.instanceId === session.providerInstanceId) ?? null)
    : null;
  // Both iOS search layouts float a bottom toolbar over the list's last rows.
  const bottomToolbarInset = Platform.OS === "ios" ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET : 0;

  return (
    <View style={{ paddingBottom: insets.bottom + bottomToolbarInset + 12 }}>
      <ChatGptSharingStatus provider={selectedProvider} />
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">Options</Text>
      <Animated.View
        className="mx-4 overflow-hidden rounded-2xl bg-grouped-card"
        layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
      >
        {session.displayedDescriptors.map((descriptor) => {
          if (descriptor.type === "select") {
            return (
              <Animated.View
                key={descriptor.id}
                entering={
                  props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined
                }
                exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
                layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
              >
                <DisclosureRow
                  label={
                    descriptor.id === "serviceTier"
                      ? "Speed"
                      : ["reasoningEffort", "effort", "reasoning", "variant"].includes(
                            descriptor.id,
                          )
                        ? "Effort"
                        : descriptor.label
                  }
                  value={
                    session.promptTraits.ultrathinkPromptControlled &&
                    descriptor.id === session.promptTraits.primarySelectDescriptor?.id
                      ? "Ultrathink"
                      : descriptor.id === "serviceTier" &&
                          getProviderOptionCurrentValue(descriptor) === "default"
                        ? "Normal"
                        : getProviderOptionCurrentLabel(
                            descriptor,
                            session.displayedModelSelection,
                            session.reportedModelSelection,
                          )
                  }
                  onPress={() => props.onOpenSubmenu({ kind: "descriptor", id: descriptor.id })}
                />
              </Animated.View>
            );
          }
          return (
            <Animated.View
              key={descriptor.id}
              entering={props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined}
              exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
              layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
            >
              <SwitchRow
                label={descriptor.id === "fastMode" ? "Speed" : descriptor.label}
                {...(descriptor.id === "fastMode"
                  ? { valueLabel: descriptor.currentValue ? "Fast" : "Normal" }
                  : {})}
                value={descriptor.currentValue ?? false}
                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
              />
            </Animated.View>
          );
        })}
        <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
          <DisclosureRow
            isLast
            label="Runtime"
            value={
              session.runtimeModeChoices.find((choice) => choice.mode === session.runtimeMode)
                ?.label
            }
            onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
          />
        </Animated.View>
      </Animated.View>

      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">Catalog</Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        <SwitchRow
          label="Manage hidden models"
          value={session.manageHidden}
          onValueChange={session.setManageHidden}
          isLast={Platform.OS === "ios" || !session.hasLegacyModels}
        />
        {Platform.OS !== "ios" && session.hasLegacyModels ? (
          <SwitchRow
            isLast
            label="Legacy models"
            onValueChange={session.setShowLegacy}
            value={session.showLegacy}
          />
        ) : null}
      </View>
    </View>
  );
}

function ThreadSettingsMainContent(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const session = useThreadSettingsSession();
  const refreshProvidersCommand = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshProviderCatalog = createProviderCatalogRefreshRunner(refreshProvidersCommand);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshProviders = () => {
    if (!session.environmentId || isRefreshingProviders) return;
    setIsRefreshingProviders(true);
    void refreshProviderCatalog(session.environmentId).then((result) => {
      setIsRefreshingProviders(false);
      const error = providerCatalogRefreshError(result);
      if (error) Dialog.alert("Could not refresh models", error);
    });
  };
  const [animationsReady, setAnimationsReady] = useState(false);
  const catalogItems = useThreadSettingsCatalogItems(session);
  const hasActiveCatalogFilter =
    session.providerFilter !== null || session.searchQuery.trim().length > 0;
  const listItems = [
    ...(catalogItems.length === 0 ? ([{ kind: "empty", key: "empty" }] as const) : catalogItems),
    { kind: "options", key: "options" },
  ] satisfies ReadonlyArray<ThreadSettingsCatalogItem>;
  const renderCatalogItem = (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
    const item = itemProps.item;
    let content: ReactNode;

    if (item.kind === "subscription") {
      content = (
        <ThreadSettingsSubscriptionRow
          option={item.option}
          recommended={item.recommended}
          isLast={item.isLast}
        />
      );
    } else if (item.kind === "model") {
      content = (
        <ThreadSettingsModelListRow
          group={item.group}
          expanded={item.expanded}
          option={item.option}
        />
      );
    } else if (item.kind === "notice") {
      content = <Text className="mx-8 mt-2 text-xs text-foreground-muted">{item.text}</Text>;
    } else if (item.kind === "empty") {
      content = (
        <View className="items-center px-8 py-14">
          <Text className="text-center text-sm text-foreground-muted">
            {session.providerFilter === FAVORITES_PROVIDER_FILTER &&
            session.searchQuery.trim().length === 0
              ? "No favorite models"
              : hasActiveCatalogFilter
                ? "No matching models"
                : "No available models"}
          </Text>
        </View>
      );
    } else {
      content = (
        <ThreadSettingsOptionsItem
          animationsReady={animationsReady}
          onOpenSubmenu={props.onOpenSubmenu}
        />
      );
    }

    return (
      <Animated.View
        key={item.key}
        entering={animationsReady ? THREAD_SETTINGS_CATALOG_ENTER_TRANSITION : undefined}
        exiting={animationsReady ? THREAD_SETTINGS_CATALOG_EXIT_TRANSITION : undefined}
      >
        {content}
      </Animated.View>
    );
  };

  return (
    // oxlint-disable-next-line t3code/require-registered-list-scroll -- Sheet content; sheets sit outside workspace columns and keep their own header handling.
    <AnimatedLegendList
      alwaysBounceVertical
      automaticallyAdjustsScrollIndicatorInsets
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{ paddingTop: 4 }}
      contentInsetAdjustmentBehavior="automatic"
      data={listItems}
      estimatedItemSize={Platform.OS === "android" ? 56 : 48}
      extraData={animationsReady}
      getItemType={(item) => item.kind}
      itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
      ListHeaderComponent={
        <>
          {session.threadRef ? (
            <ThreadMachineRow
              threadRef={session.threadRef}
              onPress={() => props.onOpenSubmenu({ kind: "machine" })}
            />
          ) : null}
          <View className="flex-row items-center justify-between px-5 py-2">
            <Text className="text-sm text-foreground-muted">
              {session.providerFilter === null ? "Default models" : "All models"}
            </Text>
            <Pressable
              accessibilityRole="button"
              className="min-h-11 justify-center"
              onPress={() =>
                session.setProviderFilter(
                  session.providerFilter === ALL_MODELS_FILTER ? null : ALL_MODELS_FILTER,
                )
              }
            >
              <Text className="text-sm text-accent">
                {session.providerFilter === ALL_MODELS_FILTER ? "Default models" : "All models"}
              </Text>
            </Pressable>
          </View>
          {Platform.OS === "android" ? (
            <View className="px-4 pb-2 pt-3">
              <View
                className="flex-row items-center rounded-full bg-input px-2"
                style={{ minHeight: 56 }}
              >
                <View pointerEvents="none" className="px-2">
                  <SymbolView
                    name="magnifyingglass"
                    size={24}
                    tintColorClassName="accent-icon-subtle"
                  />
                </View>
                <TextInput
                  accessibilityLabel="Find a model"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-w-0 flex-1 px-2 py-0 text-base text-foreground"
                  style={{ minHeight: 56, includeFontPadding: false, textAlignVertical: "center" }}
                  onChangeText={session.setSearchQuery}
                  placeholder="Find a model"
                  placeholderTextColorClassName="accent-placeholder"
                  selectionColorClassName="accent-focus/32"
                  cursorColorClassName="accent-focus"
                  selectionHandleColorClassName="accent-focus"
                  value={session.searchQuery}
                />
                {session.searchQuery.length > 0 ? (
                  <IconButton
                    accessibilityLabel="Clear model search"
                    icon="xmark"
                    onPress={() => session.setSearchQuery("")}
                  />
                ) : null}
              </View>
            </View>
          ) : null}
        </>
      }
      recycleItems
      refreshControl={
        session.environmentId ? (
          <RefreshControl refreshing={isRefreshingProviders} onRefresh={refreshProviders} />
        ) : undefined
      }
      onLoad={() => setAnimationsReady(true)}
      renderItem={renderCatalogItem}
      showsVerticalScrollIndicator={false}
    />
  );
}

function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const descriptorId = props.submenu.kind === "descriptor" ? props.submenu.id : null;

  const activeDescriptor =
    descriptorId !== null
      ? session.displayedDescriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === descriptorId,
        )
      : undefined;

  const submenuContent =
    props.submenu.kind === "runtime"
      ? {
          rows: session.runtimeModeChoices.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            description: choice.description,
            selected: choice.mode === session.runtimeMode,
            onPress: () => {
              void Haptics.selectionAsync();
              session.onUpdateRuntimeMode(choice.mode);
              props.onSelected();
            },
          })),
        }
      : activeDescriptor?.type === "select"
        ? {
            rows: selectableChoices(activeDescriptor).map((choice) => ({
              id: choice.id,
              label:
                activeDescriptor.id === "serviceTier" && choice.id === "default"
                  ? "Normal"
                  : choice.label,
              description: choice.description,
              selected:
                choice.id ===
                (session.promptTraits.ultrathinkPromptControlled &&
                activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                  ? "ultrathink"
                  : getProviderOptionCurrentValue(
                      activeDescriptor,
                      session.displayedModelSelection,
                      session.reportedModelSelection,
                    )),
              onPress: () => {
                void Haptics.selectionAsync();
                if (
                  session.promptTraits.ultrathinkInBodyText &&
                  activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                ) {
                  Dialog.alert(
                    "Reasoning controlled by prompt",
                    'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
                  );
                  return;
                }
                session.applyOptionChange(activeDescriptor.id, choice.id);
                props.onSelected();
              },
            })),
          }
        : null;

  if (!submenuContent) {
    return <View className="flex-1 bg-sheet" />;
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 16,
        paddingTop: 16,
      }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {submenuContent.rows.map((row, index) => (
          <ChoiceRow
            key={row.id}
            description={row.description}
            isLast={index === submenuContent.rows.length - 1}
            label={row.label}
            selected={row.selected}
            onPress={row.onPress}
          />
        ))}
      </View>
    </ScrollView>
  );
}

type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
};

type ThreadSettingsPickerPresentation = {
  readonly onClose: () => void;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

// With a Duo vertical bar, filter and search join cancel and confirm in the rail.
function useThreadSettingsMailSearchToolbar() {
  const metrics = useNativeLayoutMetrics();
  return useNativeMailSearchToolbar() && (metrics?.verticalBarEdge ?? "none") === "none";
}

function ThreadSettingsModelsScreen() {
  const session = useThreadSettingsSession();
  // Fork: the machine this thread runs on, under the sheet title.
  const { savedConnectionsById } = useSavedRemoteConnections();
  const machineLabel = session.environmentId
    ? savedConnectionsById[session.environmentId]?.environmentLabel
    : undefined;
  const machineSubtitle = machineLabel ? `Runs on ${machineLabel}` : undefined;
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const usesNativeMailSearchToolbar = useThreadSettingsMailSearchToolbar();
  const hasCustomCatalogFilter = session.providerFilter !== null || session.showLegacy;
  const commitAndClose = useEffectEvent(() => {
    if (!session.commitPendingModel()) return;
    presentation.onClose();
  });
  const providerFilters = [
    { id: "default-models", title: "Default models", value: null },
    { id: "all-models", title: "All models", value: ALL_MODELS_FILTER },
    { id: "favorites", title: "Favorites", value: FAVORITES_PROVIDER_FILTER },
    ...session.providerGroups.map((group) => ({
      id: `provider:${group.providerKey}`,
      title: group.providerLabel,
      value: group.providerKey,
    })),
  ];
  const filterMenu = {
    title: "Model filters",
    items: [
      {
        type: "submenu" as const,
        title: "Models",
        items: providerFilters.map((filter) => ({
          type: "action" as const,
          title: filter.title,
          state: session.providerFilter === filter.value ? ("on" as const) : ("off" as const),
          onPress: () => session.setProviderFilter(filter.value),
        })),
      },
      ...(session.hasLegacyModels
        ? [
            {
              type: "action" as const,
              title: "Show legacy models",
              state: session.showLegacy ? ("on" as const) : ("off" as const),
              onPress: () => session.setShowLegacy(!session.showLegacy),
            },
          ]
        : []),
    ],
  };

  return (
    <>
      {Platform.OS === "android" ? (
        <SheetHeader
          trailing={
            <View className="flex-row items-center">
              <AndroidAnchoredMenu
                title="Model filters"
                actions={[
                  {
                    title: "Models",
                    subactions: providerFilters.map((filter) => ({
                      id: filter.id,
                      title: filter.title,
                      state: session.providerFilter === filter.value ? "on" : "off",
                    })),
                  },
                  ...(session.hasLegacyModels
                    ? [
                        {
                          id: "show-legacy",
                          title: "Show legacy models",
                          state: session.showLegacy ? ("on" as const) : ("off" as const),
                        },
                      ]
                    : []),
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "show-legacy") {
                    session.setShowLegacy(!session.showLegacy);
                  } else {
                    const filter = providerFilters.find((item) => item.id === nativeEvent.event);
                    if (filter) session.setProviderFilter(filter.value);
                  }
                }}
              >
                {(open) => (
                  <IconButton
                    accessibilityLabel="Filter models"
                    icon="line.3.horizontal.decrease"
                    selected={hasCustomCatalogFilter}
                    variant={hasCustomCatalogFilter ? "tonal" : "standard"}
                    onPress={open}
                  />
                )}
              </AndroidAnchoredMenu>
            </View>
          }
          onCancel={presentation.onClose}
          title="Thread settings"
          confirm={session.pendingModel ? { label: "Save", onPress: commitAndClose } : undefined}
          {...(machineSubtitle ? { subtitle: machineSubtitle } : {})}
        />
      ) : null}
      <NativeStackScreenOptions
        optionsVersion={[
          session.providerFilter,
          session.providerGroups.map((group) => group.providerKey),
          session.showLegacy,
          machineSubtitle,
        ]}
        options={{
          unstable_headerSubtitle: machineSubtitle,
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  filterButtonId: "thread-settings-model-filter",
                  filterMenu,
                  filterSystemImageName: hasCustomCatalogFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onSearchTextChange: session.setSearchQuery,
                  placeholder: "Find a model",
                  searchTextChangeId: "thread-settings-model-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerShown: Platform.OS !== "android",
          headerSearchBarOptions:
            Platform.OS === "ios" && !usesNativeMailSearchToolbar
              ? {
                  allowToolbarIntegration: true,
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => session.setSearchQuery(""),
                  onChangeText: (event) => session.setSearchQuery(event.nativeEvent.text),
                  placeholder: "Find a model",
                }
              : undefined,
        }}
      />
      <ScreenContent>
        <ThreadSettingsMainContent
          onOpenSubmenu={(submenu) => {
            const title =
              submenu.kind === "machine"
                ? "Run on"
                : submenu.kind === "runtime"
                  ? "Runtime"
                  : (session.displayedDescriptors.find(
                      (descriptor) =>
                        descriptor.type === "select" &&
                        descriptor.id === (submenu.kind === "descriptor" ? submenu.id : null),
                    )?.label ?? "Option");
            navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
          }}
        />
      </ScreenContent>
      {Platform.OS === "ios" ? (
        <SheetHeader
          title="Thread settings"
          {...(machineSubtitle ? { subtitle: machineSubtitle } : {})}
          onCancel={presentation.onClose}
          accessibilityLabel="Cancel thread settings"
          confirm={{
            label: session.pendingModel ? "Save thread settings" : "Done",
            onPress: commitAndClose,
          }}
        />
      ) : null}
      {Platform.OS === "ios" && !usesNativeMailSearchToolbar ? (
        <Toolbar placement="bottom">
          <Toolbar.Menu
            accessibilityLabel="Filter models"
            icon={
              hasCustomCatalogFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Model filters"
          >
            <Toolbar.Menu title="Models">
              <Toolbar.Label>Models</Toolbar.Label>
              <Toolbar.MenuAction
                isOn={session.providerFilter === null}
                onPress={() => session.setProviderFilter(null)}
              >
                Default models
              </Toolbar.MenuAction>
              <Toolbar.MenuAction
                isOn={session.providerFilter === ALL_MODELS_FILTER}
                onPress={() => session.setProviderFilter(ALL_MODELS_FILTER)}
              >
                All models
              </Toolbar.MenuAction>
              <Toolbar.MenuAction
                isOn={session.providerFilter === FAVORITES_PROVIDER_FILTER}
                onPress={() => session.setProviderFilter(FAVORITES_PROVIDER_FILTER)}
              >
                Favorites
              </Toolbar.MenuAction>
              {session.providerGroups.map((group) => (
                <Toolbar.MenuAction
                  key={group.providerKey}
                  isOn={session.providerFilter === group.providerKey}
                  onPress={() => session.setProviderFilter(group.providerKey)}
                >
                  {group.providerLabel}
                </Toolbar.MenuAction>
              ))}
            </Toolbar.Menu>
            {session.hasLegacyModels ? (
              <Toolbar.MenuAction
                isOn={session.showLegacy}
                onPress={() => session.setShowLegacy(!session.showLegacy)}
              >
                Show legacy models
              </Toolbar.MenuAction>
            ) : null}
          </Toolbar.Menu>
          <Toolbar.SearchBarSlot />
        </Toolbar>
      ) : null}
    </>
  );
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={route.params.title}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <ScreenContent>
        {route.params.kind === "machine" && session.threadRef ? (
          <ThreadMachineChoices threadRef={session.threadRef} onClose={presentation.onClose} />
        ) : (
          <ThreadSettingsChoiceContent
            submenu={route.params}
            onSelected={() => navigation.goBack()}
          />
        )}
      </ScreenContent>
    </>
  );
}

function ThreadSettingsPickerNavigator(props: ThreadSettingsPickerPresentation) {
  const theme = useUniwindTheme();
  const solidSheetBackground = theme["--color-sheet-solid"];
  const foreground = theme["--color-foreground"];
  const presentation = {
    onClose: props.onClose,
  };

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={{
          animation: Platform.OS === "android" ? "default" : "slide_from_right",
          contentStyle: { backgroundColor: solidSheetBackground },
          gestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShown: Platform.OS !== "android",
          headerShadowVisible: false,
          headerStyle: {
            backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED ? "transparent" : solidSheetBackground,
          },
          headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
          headerTintColor: foreground,
          headerTitleStyle: { fontSize: 17, fontWeight: "700" },
          scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
            ? THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS
            : undefined,
        }}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
          options={{ headerBackVisible: false, title: "Thread settings" }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsChoice"
          component={ThreadSettingsChoiceScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
      </ThreadSettingsPickerStack.Navigator>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}

export function ThreadSettingsPickerScreen(
  props: ThreadSettingsSessionProps & { readonly onClose: () => void },
) {
  return (
    <ThreadSettingsSessionProvider {...props}>
      <ThreadSettingsPickerNavigator onClose={props.onClose} />
    </ThreadSettingsSessionProvider>
  );
}

export function ExistingThreadSettingsRouteScreen({
  route,
}: StaticScreenProps<ExistingThreadSettingsRouteParams>) {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  // Reads the same environmentId/threadId params as the Thread route beneath it.
  const { selectedThread, selectedThreadDetailRef, selectedEnvironmentRuntime } =
    useThreadSelection();
  // Streamed text would otherwise re-render the whole model picker on every delta.
  const structure = useQuietThreadStructure(selectedThreadDetailRef);
  const reportedModelSelection = useThreadReportedModelSelection(selectedThreadDetailRef);
  const threadKey = scopedThreadKey(route.params.environmentId, route.params.threadId);
  const draftSettings = useComposerDraftSettings(threadKey);
  const queuedRunEdit = useQueuedRunEdit(threadKey);
  // A queued edit can end while the sheet is open; the prompt then belongs to the thread's draft.
  const draftKey = activeComposerDraftKey(threadKey, route.params.draftKey, queuedRunEdit);
  const prompt = useComposerDraft(draftKey).text;

  if (!selectedThread) {
    return <View className="flex-1 bg-sheet" />;
  }

  const serverConfig = selectedEnvironmentRuntime?.serverConfig ?? null;
  const modelSelection = draftSettings.modelSelection ?? selectedThread.modelSelection;
  const lockedProviderInstanceId = threadAllowsProviderSwitch({
    thread: selectedThread,
    projection: structure?.projection,
  })
    ? undefined
    : modelSelection.instanceId;
  const modelOptions = buildModelOptions(
    serverConfig,
    modelSelection,
    lockedProviderInstanceId,
    selectedThread.projectId,
  );
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === modelSelection.instanceId &&
        option.selection.model === modelSelection.model,
    ) ?? null;
  const updateModelSelection = (selection: ModelSelection) =>
    updateThreadDraftModelSelection(threadKey, selection, serverConfig?.providers ?? []);

  return (
    <ThreadSettingsPickerScreen
      threadRef={scopeThreadRef(selectedThread.environmentId, selectedThread.id)}
      environmentId={selectedThread.environmentId}
      projectId={selectedThread.projectId}
      providerInstanceId={modelSelection.instanceId}
      {...(lockedProviderInstanceId ? { lockedProviderInstanceId } : {})}
      providerGroups={groupByProvider(modelOptions)}
      selectedModel={modelSelection}
      prompt={prompt}
      onPromptChange={(text) => setComposerDraftText(draftKey, text)}
      reportedModelSelection={reportedModelSelection}
      onSelectModel={(option) => updateModelSelection(withRememberedModelOptions(option.selection))}
      restoreSelection={withRememberedModelOptions}
      optionDescriptors={resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: modelSelection.options,
      })}
      onUpdateOptionSelections={(options) => {
        rememberModelOptions(modelSelection.instanceId, modelSelection.model, options ?? []);
        updateModelSelection({ ...modelSelection, options });
      }}
      runtimeMode={draftSettings.runtimeMode ?? selectedThread.runtimeMode}
      onUpdateRuntimeMode={(runtimeMode) => updateComposerDraftSettings(threadKey, { runtimeMode })}
      onClose={() => navigation.goBack()}
    />
  );
}

/** RNS owns nested sheet dismissal; Reasoning and Runtime remain ordinary pushes. */
export function NewTaskThreadSettingsRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const optionDescriptors = resolveProviderOptionDescriptors({
    capabilities: flow.selectedModelOption?.capabilities,
    selections: flow.selectedModel?.options,
  });

  return (
    <ThreadSettingsPickerScreen
      environmentId={flow.selectedEnvironmentId}
      projectId={flow.selectedProject?.id ?? null}
      {...(flow.selectedModel ? { providerInstanceId: flow.selectedModel.instanceId } : {})}
      providerGroups={flow.providerGroups}
      selectedModel={flow.selectedModel}
      prompt={flow.prompt}
      onPromptChange={flow.setPrompt}
      onSelectModel={(option) => flow.setSelectedModelKey(option.key, option.selection.options)}
      restoreSelection={withRememberedModelOptions}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={flow.setSelectedModelOptions}
      runtimeMode={flow.runtimeMode}
      onUpdateRuntimeMode={flow.setRuntimeMode}
      onClose={() => navigation.goBack()}
    />
  );
}

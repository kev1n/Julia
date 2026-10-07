import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { defaultModelPriority, groupModelSubscriptions } from "@t3tools/shared/modelSubscriptions";
import { useAtomValue } from "@effect/atom-react";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { CheckIcon, ChevronDownIcon, StarIcon, Settings2Icon } from "lucide-react";
import { hasProviderSetup, getProviderStatusMessage } from "./ProviderStatusBanner";
import { modelPickerModelKey } from "./modelPickerKeys";
import { scoreModelPickerSearch } from "@t3tools/client-runtime/model-search";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { getModelPickerDisplayName, type ModelEsque } from "./providerIconUtils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { registerModelPickerContent } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import {
  useEnvironmentModelPreferences,
  useUpdateEnvironmentModelPreferences,
} from "~/hooks/useSettings";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Button, InlineButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { providerModelKey } from "../../modelOrdering";
import { accountLimitSummary } from "../../fork/usageByAccount/accountSummary";
import { useNowMinute } from "../../hooks/useNowMinute";

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    (input.entry.driverKind === "opencode" || input.entry.driverKind === "antigravity") &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      !options.some((option) => !option.isUnavailable))
  );
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  environmentId: EnvironmentId | null;
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Configured subscriptions in display order, scoped to the destination environment. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** The owning popup moves focus here when it opens (its `initialFocus`). */
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Sits beside an effort column: fills the shared row, and stacks above it on narrow screens. */
  docked?: boolean;
  /** Right at the end of the search text moves into the popup's effort column. */
  onFocusEffort?: () => void;
  /** Closes the list column, inside the popup's fixed height. */
  listFooter?: ReactNode;
}) {
  const {
    searchInputRef,
    activeInstanceId,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleModel,
    selectedModels,
    lockedProvider,
    lockedContinuationGroupKey,
    terminalOpen,
    onRequestClose,
    onOpenProviderSetup,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const [showAllModels, setShowAllModels] = useState(false);
  const [editingDefaults, setEditingDefaults] = useState(false);
  const [expandedModels, setExpandedModels] = useState<ReadonlySet<string>>(() => new Set());
  const modelListRef = useRef<LegendListRef | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes this picker's mount to global keydown handlers
  useLayoutEffect(() => registerModelPickerContent(), []);
  const highlightedKeyRef = useRef<string | null>(null);
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });
  const updateScrollFade = () => {
    const element = modelListRef.current?.getScrollableNode?.();
    if (!(element instanceof HTMLElement)) return;
    const top = element.scrollTop > 1;
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop > 1;
    setScrollFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };
  const { favorites } = useEnvironmentModelPreferences(props.environmentId);
  const saveModelPreferences = useUpdateEnvironmentModelPreferences(props.environmentId);
  const navigate = useNavigate();
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = props.keybindings ?? serverKeybindings;
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}Z`);
  const entryById = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));
  const activeEntry = entryById.get(activeInstanceId);
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(activeInstanceId) ?? [],
  });
  const activeSlug = activeModel?.slug ?? props.model;
  const selectedKeys = new Set(
    (selectedModels ?? [{ instanceId: activeInstanceId, model: activeSlug }]).map((selection) => {
      const entry = entryById.get(selection.instanceId);
      const selectedModel = resolveModelPickerSelectedModel({
        driverKind: entry?.driverKind,
        model: selection.model,
        options: modelOptionsByInstance.get(selection.instanceId) ?? [],
      });
      return modelPickerModelKey(selection.instanceId, selectedModel?.slug ?? selection.model);
    }),
  );
  const favoriteKeys = new Set(
    favorites.map((favorite) => providerModelKey(favorite.provider, favorite.model)),
  );
  const matchesLock = (entry: ProviderInstanceEntry) =>
    lockedProvider === null ||
    (entry.driverKind === lockedProvider &&
      (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey));
  const groups = groupModelSubscriptions(
    instanceEntries.flatMap((entry) => {
      if (!matchesLock(entry)) return [];
      return (modelOptionsByInstance.get(entry.instanceId) ?? [])
        .filter((model) =>
          shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: activeInstanceId,
            activeModel: activeSlug,
          }),
        )
        .map((model) => ({
          instanceId: entry.instanceId,
          // Generic ACP instances may represent unrelated agents with the same slug.
          catalog:
            entry.driverKind === "acpRegistry"
              ? `acpRegistry:${entry.acpRegistryAgentId ?? entry.instanceId}`
              : entry.driverKind,
          model: model.slug,
          available:
            isProviderInstancePickerReady(entry) &&
            entry.installed &&
            entry.snapshot.auth.status !== "unauthenticated" &&
            !model.isUnavailable &&
            !getModelDisabledReason?.(entry.instanceId, model.slug),
          usageLimits: entry.snapshot.usageLimits,
          value: { entry, model },
        }));
    }),
    now,
  );
  const groupIsFavorite = (group: (typeof groups)[number]) =>
    group.subscriptions.some((subscription) =>
      favoriteKeys.has(providerModelKey(subscription.instanceId, subscription.model)),
    );
  const groupIsSelected = (group: (typeof groups)[number]) =>
    group.subscriptions.some((subscription) =>
      selectedKeys.has(modelPickerModelKey(subscription.instanceId, subscription.model)),
    );
  const hasFavorites = groups.some(groupIsFavorite);
  const visibleGroups = (() => {
    const searching = searchQuery.trim().length > 0;
    const firstByCatalog = new Set<string>();
    return groups
      .map((group, index) => {
        const first = group.subscriptions[0]!;
        const isFirst = !firstByCatalog.has(first.catalog);
        if (group.subscriptions.some((subscription) => !subscription.value.model.isLegacy)) {
          firstByCatalog.add(first.catalog);
        }
        const favorite = groupIsFavorite(group);
        const selected = groupIsSelected(group);
        const priority = defaultModelPriority(first.catalog, first.model);
        const isDefault =
          priority < 3 ||
          group.subscriptions.some((subscription) => subscription.value.model.isDefault) ||
          (isFirst && !first.value.model.isLegacy);
        const score = searching
          ? group.subscriptions.reduce<number | null>((best, subscription) => {
              const { entry, model } = subscription.value;
              const match = scoreModelPickerSearch(
                {
                  name: model.name,
                  ...(model.shortName ? { shortName: model.shortName } : {}),
                  ...(model.subProvider ? { subProvider: model.subProvider } : {}),
                  driverKind: entry.driverKind,
                  providerDisplayName: entry.displayName,
                  isFavorite: favorite,
                },
                searchQuery,
              );
              return match === null ? best : best === null ? match : Math.min(best, match);
            }, null)
          : 0;
        const favoriteIndex = favorite
          ? favorites.findIndex((fav) =>
              group.subscriptions.some(
                (subscription) =>
                  subscription.instanceId === fav.provider && subscription.model === fav.model,
              ),
            )
          : Number.POSITIVE_INFINITY;
        return { group, index, favorite, selected, isDefault, score, favoriteIndex, priority };
      })
      .filter(
        (item) =>
          item.score !== null &&
          (searching ||
            showAllModels ||
            item.selected ||
            item.priority < 3 ||
            (hasFavorites ? item.favorite : item.isDefault)),
      )
      .toSorted(
        (a, b) =>
          (a.score ?? 0) - (b.score ?? 0) ||
          a.priority - b.priority ||
          a.favoriteIndex - b.favoriteIndex ||
          a.index - b.index,
      )
      .map((item) => item.group);
  })();
  const rows = visibleGroups.flatMap((group) => {
    // A saved selection is an explicit override. Other models use the best account now.
    const choice =
      group.subscriptions.find((subscription) =>
        selectedKeys.has(modelPickerModelKey(subscription.instanceId, subscription.model)),
      ) ??
      group.recommended ??
      group.subscriptions[0]!;
    return [
      { key: `group:${group.key}`, group, choice, kind: "model" as const },
      ...(expandedModels.has(group.key)
        ? group.subscriptions.map((subscription, index) => ({
            key: modelPickerModelKey(subscription.instanceId, subscription.model),
            group,
            choice: subscription,
            kind: "subscription" as const,
            first: index === 0,
            last: index === group.subscriptions.length - 1,
          }))
        : []),
    ];
  });
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const rowKeys = rows.map((row) => row.key);
  const selectedRowKeys = rows
    .filter((row) =>
      row.kind === "model" ? groupIsSelected(row.group) : selectedKeys.has(row.key),
    )
    .map((row) => row.key);
  const toggleExpanded = (key: string) => {
    setExpandedModels((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleFavorite = (group: (typeof groups)[number]) => {
    const isFavorite = groupIsFavorite(group);
    const choice = group.recommended ?? group.subscriptions[0]!;
    // One favorite per model group: unfavoriting clears every account, favoriting marks one.
    void saveModelPreferences({
      setModelFavorites: isFavorite
        ? group.subscriptions.map((subscription) => ({
            provider: subscription.instanceId,
            model: subscription.model,
            favorite: false,
          }))
        : [{ provider: choice.instanceId, model: choice.model, favorite: true }],
    });
  };
  const handleSubscriptionSelect = (
    subscription: (typeof groups)[number]["subscriptions"][number],
    additive = false,
  ) => {
    if (!subscription.available) return;
    const { entry, model } = subscription.value;
    const resolved = resolveSelectableModel(
      entry.driverKind,
      model.slug,
      modelOptionsByInstance.get(entry.instanceId) ?? [],
    );
    if (!resolved) return;
    if (additive && onToggleModel) onToggleModel(entry.instanceId, resolved);
    else onInstanceModelChange(entry.instanceId, resolved);
  };
  const handleSelect = (key: string, additive = false) => {
    const row = rowByKey.get(key);
    if (row) handleSubscriptionSelect(row.choice, additive);
  };
  const shortcutContext = {
    terminalFocus: false,
    terminalOpen: terminalOpen,
    modelPickerOpen: true,
  };
  const jumpRows = rows.filter((row) => row.kind === "model" && row.choice.available).slice(0, 9);
  const jumpLabels = new Map(
    jumpRows.map((row, index) => {
      const command = modelPickerJumpCommandForIndex(index);
      return [
        row.key,
        command
          ? shortcutLabelForCommand(keybindings, command, {
              platform: navigator.platform,
              context: shortcutContext,
            })
          : null,
      ];
    }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a capture-phase window keydown listener for the picker's lifetime
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        isCommandPaletteOpen()
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: shortcutContext,
      });
      if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
        const key = highlightedKeyRef.current ?? selectedRowKeys[0] ?? rowKeys[0];
        const row = key ? rowByKey.get(key) : undefined;
        if (!row) return;
        const subscriptions = row.group.subscriptions.filter(
          (subscription) => subscription.available,
        );
        if (subscriptions.length < 2) return;
        const current = subscriptions.indexOf(row.choice);
        const direction = command === "modelPicker.nextProvider" ? 1 : -1;
        const next =
          subscriptions[(current + direction + subscriptions.length) % subscriptions.length];
        if (next) {
          event.preventDefault();
          event.stopPropagation();
          handleSubscriptionSelect(next);
        }
        return;
      }
      const index = modelPickerJumpIndexFromCommand(command ?? "");
      if (index !== null && jumpRows[index]) {
        event.preventDefault();
        event.stopPropagation();
        handleSelect(jumpRows[index].key);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    keybindings,
    shortcutContext,
    jumpRows,
    handleSelect,
    handleSubscriptionSelect,
    selectedRowKeys,
    rowKeys,
    rowByKey,
  ]);

  const [contentSize, setContentSize] = useState(() => rows.length * 76);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the virtual list's measured total size to size the popup and its scroll fades
  useLayoutEffect(
    () =>
      modelListRef.current?.getState().listen("totalSize", (size) => {
        setContentSize(size);
        updateScrollFade();
      }),
    [updateScrollFade],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the list scroller's size to update its scroll fades
  useLayoutEffect(() => {
    const element = modelListRef.current?.getScrollableNode?.();
    if (!(element instanceof HTMLElement)) return;
    return observeResize(
      element.firstElementChild ? [element, element.firstElementChild] : element,
      () => updateScrollFade(),
    );
  }, [updateScrollFade]);
  const setupEntries = onOpenProviderSetup
    ? instanceEntries.filter(
        (entry) =>
          matchesLock(entry) &&
          shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? []),
      )
    : [];
  const updateRequiredNotices = (
    searchQuery.trim().length > 0
      ? instanceEntries.filter(matchesLock)
      : activeEntry
        ? [activeEntry]
        : []
  ).flatMap((entry) => {
    const notice = formatProviderUpdateRequiredNotice(entry.snapshot, searchQuery);
    return notice ? [{ instanceId: entry.instanceId, notice }] : [];
  });

  return (
    <TooltipProvider delay={0}>
      <div
        className={cn(
          "flex w-[min(24rem,calc(100vw-1rem))] flex-col overflow-hidden",
          props.docked
            ? "min-h-0 max-sm:h-56 max-sm:w-full"
            : "max-h-[min(40rem,var(--available-height))]",
        )}
        data-model-picker-content="true"
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onRequestClose?.();
          }
        }}
      >
        <Combobox<string, boolean>
          inline
          items={rowKeys}
          filteredItems={rowKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          multiple={onToggleModel !== undefined}
          value={onToggleModel ? selectedRowKeys : (selectedRowKeys[0] ?? null)}
          onItemHighlighted={(key, details) => {
            highlightedKeyRef.current = typeof key === "string" ? key : null;
            if (details.reason === "keyboard" && details.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: details.index,
                animated: false,
              });
            }
          }}
          onValueChange={(value, details) => {
            const key = Array.isArray(value)
              ? (value.find((key) => !selectedRowKeys.includes(key)) ??
                selectedRowKeys.find((key) => !value.includes(key)))
              : value;
            if (typeof key === "string")
              handleSelect(key, "shiftKey" in details.event && details.event.shiftKey === true);
          }}
        >
          <ComboboxSearchInput
            ref={searchInputRef}
            placeholder="Search models"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                (
                  event as typeof event & { preventBaseUIHandler?: () => void }
                ).preventBaseUIHandler?.();
                event.stopPropagation();
                return;
              }
              const highlightedKey = highlightedKeyRef.current ?? selectedRowKeys[0] ?? rowKeys[0];
              const expandable = highlightedKey ? rowByKey.get(highlightedKey) : undefined;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onRequestClose?.();
              } else if (event.key === "Enter" && highlightedKey) {
                (
                  event as typeof event & { preventBaseUIHandler?: () => void }
                ).preventBaseUIHandler?.();
                event.preventDefault();
                event.stopPropagation();
                handleSelect(highlightedKey, event.shiftKey);
              } else if (
                event.key === "ArrowRight" &&
                expandable &&
                !expandedModels.has(expandable.group.key)
              ) {
                event.preventDefault();
                event.stopPropagation();
                toggleExpanded(expandable.group.key);
              } else if (
                event.key === "ArrowRight" &&
                props.onFocusEffort &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey &&
                event.currentTarget.selectionStart === searchQuery.length
              ) {
                event.preventDefault();
                event.stopPropagation();
                props.onFocusEffort();
              } else if (event.key === "ArrowLeft" && highlightedKey) {
                const row = rowByKey.get(highlightedKey);
                if (row && expandedModels.has(row.group.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleExpanded(row.group.key);
                }
              } else event.stopPropagation();
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          />
          <div
            className={cn("min-h-0 overflow-hidden", props.docked && rows.length > 0 && "flex-1")}
            style={
              props.docked ? undefined : { height: rows.length ? Math.min(contentSize + 16, 440) : 0 }
            }
          >
            <ComboboxListVirtualized>
              <LegendList<string>
                ref={modelListRef}
                data={rowKeys}
                extraData={rows}
                keyExtractor={(key) => key}
                estimatedItemSize={76}
                recycleItems={false}
                onLayout={updateScrollFade}
                onScroll={updateScrollFade}
                className={cn(
                  "size-full min-h-0 scroll-py-6 overscroll-y-contain",
                  getVirtualizedScrollFadeClassName(scrollFade),
                )}
                contentContainerStyle={{ padding: 6 }}
                renderItem={({ item: key, index }) => {
                  const row = rowByKey.get(key);
                  if (!row) return null;
                  const { entry, model } = row.choice.value;
                  const summary = accountLimitSummary(entry.snapshot, now) ?? "Usage unavailable";
                  const selected =
                    row.kind === "model" ? groupIsSelected(row.group) : selectedKeys.has(key);
                  const reason =
                    getModelDisabledReason?.(entry.instanceId, model.slug) ??
                    (model.isUnavailable ? "Model unavailable" : null);
                  if (row.kind === "subscription")
                    return (
                      <div
                        className={cn(
                          "ml-7 border-l-2 border-border bg-background/50 px-2",
                          row.first && "rounded-tr-md pt-1",
                          row.last && "mb-2 rounded-br-md pb-1",
                        )}
                      >
                        <ComboboxItem
                          index={index}
                          value={key}
                          disabled={!row.choice.available}
                          hideIndicator
                          title={reason ?? undefined}
                        >
                          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 text-sm">
                                <span className="truncate">{entry.displayName}</span>
                                {row.group.recommended === row.choice ? (
                                  <span className="text-2xs text-muted-foreground">
                                    Recommended
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-xs leading-5 tabular-nums text-muted-foreground">
                                {reason ?? summary}
                              </div>
                            </div>
                            {selected ? <CheckIcon className="size-3.5" /> : null}
                          </div>
                        </ComboboxItem>
                      </div>
                    );
                  const expanded = expandedModels.has(row.group.key);
                  return (
                    <div className={expanded ? "" : "pb-1"}>
                      <ComboboxItem
                        index={index}
                        value={key}
                        disabled={!row.choice.available}
                        hideIndicator
                        density="comfortable"
                        title={reason ?? undefined}
                      >
                        <ProviderInstanceIcon
                          driverKind={entry.driverKind}
                          displayName={entry.displayName}
                          accentColor={entry.accentColor}
                          acpRegistryAgentId={entry.acpRegistryAgentId}
                          acpRegistryIconUrl={entry.acpRegistryIconUrl}
                          className="size-4"
                          iconClassName="size-4"
                        />
                        <span className="min-w-0 flex-1 truncate text-base font-normal">
                          {getModelPickerDisplayName(model)}
                        </span>
                        {selected ? (
                          <CheckIcon className="size-3.5" />
                        ) : jumpLabels.get(key) ? (
                          <Kbd>{jumpLabels.get(key)}</Kbd>
                        ) : null}
                        {editingDefaults ? (
                          <Button
                            variant="ghost-muted"
                            size="icon-sm"
                            aria-label={
                              groupIsFavorite(row.group)
                                ? "Remove from default models"
                                : "Add to default models"
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleFavorite(row.group);
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <StarIcon
                              className={cn(
                                "size-3.5",
                                groupIsFavorite(row.group) && "fill-current text-warning",
                              )}
                            />
                          </Button>
                        ) : null}
                      </ComboboxItem>
                      <Tooltip>
                        <TooltipTrigger
                          render={<button type="button" />}
                          aria-label={`Subscriptions for ${getModelPickerDisplayName(model)}`}
                          aria-expanded={expanded}
                          className="flex min-h-7 w-full items-center gap-2 rounded-md py-1 pl-8 pr-3 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-10"
                          onClick={() => toggleExpanded(row.group.key)}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <span className="min-w-0 flex-1 truncate leading-5 tabular-nums">
                            {expanded
                              ? `Subscriptions · ${row.group.subscriptions.length} accounts`
                              : `${entry.displayName.replace(/^(Claude|Codex)\s+/, "")} · ${reason ?? summary}`}
                          </span>
                          <ChevronDownIcon
                            className={cn(
                              "size-3.5 shrink-0 transition-transform",
                              expanded && "rotate-180",
                            )}
                          />
                        </TooltipTrigger>
                        <TooltipPopup side="right">
                          {entry.displayName} · {reason ?? summary}
                        </TooltipPopup>
                      </Tooltip>
                    </div>
                  );
                }}
              />
            </ComboboxListVirtualized>
          </div>
          {rows.length === 0 ? <ComboboxEmpty>No available models</ComboboxEmpty> : null}
        </Combobox>
        {setupEntries.length ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {setupEntries.map((entry) => (
              <div key={entry.instanceId} className="py-1">
                <span>{getProviderStatusMessage(entry.snapshot)} </span>
                <InlineButton
                  onClick={() => {
                    onRequestClose?.();
                    onOpenProviderSetup?.(entry.instanceId);
                  }}
                >
                  Set up {entry.displayName}
                </InlineButton>
              </div>
            ))}
          </div>
        ) : null}
        {updateRequiredNotices.map(({ instanceId, notice }) => (
          <p
            key={instanceId}
            className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
          >
            {notice}{" "}
            <InlineButton
              onClick={() => {
                onRequestClose?.();
                void navigate({ to: "/settings/providers" });
              }}
            >
              Provider settings
            </InlineButton>
          </p>
        ))}
        {props.listFooter}
        <div className="flex min-h-10 shrink-0 items-center justify-between border-t border-border/60 px-3 text-xs text-muted-foreground">
          <button
            type="button"
            className="flex min-h-10 items-center gap-1.5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-pressed={editingDefaults}
            onClick={() => setEditingDefaults((editing) => !editing)}
          >
            <Settings2Icon className="size-3.5" />
            {editingDefaults ? "Done" : "Edit"}
          </button>
          <button
            type="button"
            className="min-h-10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setShowAllModels((all) => !all)}
          >
            {showAllModels ? "Defaults" : "All models"}
          </button>
        </div>
      </div>
    </TooltipProvider>
  );
});

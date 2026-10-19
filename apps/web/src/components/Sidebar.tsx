import { attachSidebarTree, SIDEBAR_TREE_PROPS } from "../lib/sidebarTree";
import { type EnvironmentId, type ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag as moveThreadContextDragGhost,
} from "./chat/threadContextDrag";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  createInboxReturnTracker,
  isThreadWorking,
} from "@t3tools/client-runtime/state/thread-inbox";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  nextShownOrder,
  threadSearchMatchKey,
  threadSearchSubject,
  type ShownOrder,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankMessageMatches } from "@t3tools/shared/paletteSearch";
import { findForMessageMatch, openThreadFindOnQuery } from "./chat/threadFindStore";
import {
  groupWorkspaceChatSessions,
  type WorkspaceChatSection,
} from "@t3tools/client-runtime/state/workspace-chat-sessions";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";

import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  ListFilterIcon,
  PinIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { type AnyRouter, useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import {
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
  resolveSidebarProjectScopeKeys,
  getSidebarProjectSettingsKey,
  groupSidebarThreadsUnderProjects,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import {
  legacyProjectCwdPreferenceKey,
  resolveProjectExpanded,
  useUiStateStore,
} from "../uiStateStore";
import {
  SidebarHiddenProjectsButton,
  SidebarProjectHeader,
  type SidebarProjectDropPosition,
} from "./sidebar/SidebarProjectHeader";
import { SortableTabSessionRow, SidebarTabSessionRow } from "./sidebar/SidebarTabSessionRow";
import { useShallow } from "zustand/react/shallow";
import { countSidebarDraftSessions } from "../sidebarDraftSessions";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { useAcknowledgeThreadWoke, useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { registerSettleAndAdvance } from "../settleAndAdvance";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import {
  updateClientSettings,
  useBoringSidebarEnabled,
  useClientSettings,
} from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import {
  useEnvironmentIdentities,
  useConnectedEnvironmentIds,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  readThreadShell,
  useAllEnvironmentProjectSnapshotsReady,
  useDelegatedUnderParent,
  useProjects,
  useServerConfigs,
  useQuietThreadShells,
} from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentProjects } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../state/olderSettledShelf";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { canShareWithGuestAtom } from "./chat/guestShareAvailability";
import { openGuestShareDialog } from "./chat/guestShareDialogState";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { cn } from "~/lib/utils";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
} from "./threadActionMenu.logic";
import {
  applySidebarThreadDrop,
  filterSidebarV2VisibleThreads,
  groupSidebarThreadsByProject,
  sidebarFolderExpansionKeys,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  firstValidTimestampMs,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planSidebarThreadDrop,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  resolveSidebarThreadSection,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  sidebarListItemId,
  sidebarProjectHeaderId,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortSidebarV2ProjectGroups,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useSnoozeWakeClock,
  useThreadJumpHintsVisible,
  type SidebarListItem,
  type SidebarSection,
  resolveSidebarRowThreadId,
} from "./Sidebar.logic";
import { createSidebarCollisionDetection, createSidebarSortingStrategy } from "./Sidebar.drag";
import { SidebarPointerSensor } from "./Sidebar.pointer";
import { SidebarDragRegions, SidebarDropSlot } from "./SidebarDropSlot";
import { createSidebarListMotion } from "./Sidebar.motion";
import {
  pickSnoozePreset,
  resolveSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "./Sidebar.snooze";
import { ProjectFavicon } from "./ProjectFavicon";
import { deriveProviderEntriesByEnvironment } from "../providerInstances";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  resolveSidebarRouteReveal,
  type SidebarRouteReveal,
  useActiveRowReveal,
} from "./sidebar/routeReveal";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { copyThreadReference } from "../lib/copyThreadReference";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "./ui/combobox";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarHeaderIconButton, SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { TooltipProvider } from "./ui/tooltip";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  SidebarSearchResultRow,
  SidebarThreadRow,
  SortableThreadRow,
  type SidebarProviderEntry,
  type SidebarSweepAction,
} from "./sidebar/SidebarThreadRow";
import { SidebarDraftBlock } from "./sidebar/SidebarDraftBlock";
import {
  SidebarProjectFolderHeader,
  sidebarFolderRowId,
} from "./sidebar/SidebarProjectFolderHeader";
import {
  SidebarSectionHeader,
  SidebarSectionPlaceholder,
  SortableSidebarMarker,
} from "./sidebar/SidebarListMarkers";

function sameSidebarProviderEntries(
  left: ReadonlyMap<string, SidebarProviderEntry>,
  right: ReadonlyMap<string, SidebarProviderEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [instanceId, entry] of right) {
    const other = left.get(instanceId);
    if (
      other === undefined ||
      other.driverKind !== entry.driverKind ||
      other.enabled !== entry.enabled ||
      other.displayName !== entry.displayName ||
      other.accentColor !== entry.accentColor ||
      other.acpRegistryAgentId !== entry.acpRegistryAgentId ||
      other.acpRegistryIconUrl !== entry.acpRegistryIconUrl ||
      other.models !== entry.models
    ) {
      return false;
    }
  }
  return true;
}

// Resolve providers per environment because default instance ids collide across environments.
const sidebarProviderEntriesAtom = Atom.make((get) => {
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  const derived = deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  const previous = Option.getOrNull(
    get.self<ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>>(),
  );
  const next = new Map<string, ReadonlyMap<string, SidebarProviderEntry>>();
  let changed = previous === null || previous.size !== derived.size;
  for (const [environmentId, entries] of derived) {
    const prior = previous?.get(environmentId);
    if (prior !== undefined && sameSidebarProviderEntries(prior, entries)) {
      next.set(environmentId, prior);
    } else {
      next.set(environmentId, entries);
      changed = true;
    }
  }
  return !changed && previous !== null ? previous : next;
}).pipe(Atom.withLabel("sidebar-provider-entries"));

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
const SETTLED_SHELF_EXPANDED_KEY = "t3code:sidebar:settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "t3code:sidebar:snoozed-expanded";
const WORKING_SHELF_EXPANDED_KEY = "t3code:sidebar:working-expanded";

const inboxReturns = createInboxReturnTracker();

type SidebarOptimisticDrop = {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled";
  readonly occurredAt: string;
  readonly clearsSnooze: boolean;
  readonly order: readonly string[] | null;
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  readonly assignedKeys: ReadonlyMap<string, string>;
};

interface SidebarThreadPartitionInput {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  /** Tasks linked environments run for a listed thread; they show under it. */
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly workingShelfEnabled: boolean;
  /** Boring mode: folders list active threads by the user's latest message. */
  readonly sortActiveBySend: boolean;
  readonly routeThreadRef: ScopedThreadRef | null;
  // Snooze wakes, the queued-turn grace and the Working shelf's exit grace depend
  // on the clock, so the minute tick, the precise snooze-wake tick and the inbox
  // tracker's expiry version are inputs: a new key repartitions.
  readonly clockKey: string;
}

function threadShellKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

const NO_DRAGGED_ORDER: readonly string[] = [];
const NO_DRAGGED_ORDERS: {
  readonly settledOrder: readonly string[];
  readonly activeOrder: readonly string[] | undefined;
} = { settledOrder: NO_DRAGGED_ORDER, activeOrder: undefined };

function resolveDraggedOrders(input: {
  readonly drag: { readonly activeKey: string; readonly occurredAt: string };
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly sessionByThreadKey: ReadonlyMap<string, { readonly latestSentAt: string }>;
  readonly workingShelfEnabled: boolean;
}): typeof NO_DRAGGED_ORDERS {
  const { drag, threadByKey, settledThreads, activeThreads, sessionByThreadKey } = input;
  const thread = threadByKey.get(drag.activeKey);
  if (thread === undefined) return NO_DRAGGED_ORDERS;
  const others = (list: readonly EnvironmentThreadShell[]) =>
    list.filter((candidate) => threadShellKey(candidate) !== drag.activeKey);
  return {
    settledOrder: sortSettledThreads([
      ...others(settledThreads),
      applySidebarThreadDrop(thread, "settled", drag.occurredAt),
    ]).map(threadShellKey),
    // Active sessions are send-ordered, including during a lifecycle drop.
    activeOrder: input.workingShelfEnabled
      ? [...others(activeThreads), applySidebarThreadDrop(thread, "active", drag.occurredAt)]
          .toSorted((left, right) => {
            const sentAt = (candidate: EnvironmentThreadShell) =>
              sessionByThreadKey.get(threadShellKey(candidate))?.latestSentAt ??
              candidate.latestUserMessageAt ??
              candidate.createdAt;
            return (
              sentAt(right).localeCompare(sentAt(left)) ||
              threadShellKey(left).localeCompare(threadShellKey(right))
            );
          })
          .map(threadShellKey)
      : undefined,
  };
}

function routeThreadOnly(
  threads: readonly EnvironmentThreadShell[],
  routeThreadKey: string | null,
): readonly EnvironmentThreadShell[] {
  if (routeThreadKey === null) return EMPTY_THREADS;
  const routeThread = threads.find((thread) => threadShellKey(thread) === routeThreadKey);
  return routeThread === undefined ? EMPTY_THREADS : [routeThread];
}

// Separate hooks cache maps independently of later Sidebar hooks and preserve dnd-kit inputs.
function useSidebarThreads(input: {
  readonly projectScopeKey: string | null;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly routeRowThreadKey: string | null;
  // Set in boring mode: the project groups to fold active threads into, in order.
  readonly folderGroups: readonly SidebarProjectSnapshot[] | null;
  // Keeps folders with no active threads, so a project the user filtered to can start one.
  readonly keepEmptyFolders: boolean;
  readonly routeThreadRef: ScopedThreadRef | null;
  // While settle or snooze moves you off this thread, collapsed shelves
  // stop revealing it; see parkingRouteThreadKey.
  readonly parkingRouteThreadKey: string | null;
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly scopedProjectGroups: readonly SidebarProjectSnapshot[];
  readonly draftCountsByProjectKey: ReadonlyMap<string, number>;
}) {
  const {
    projectScopeKey,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    threads,
    delegatedUnderParent,
    routeRowThreadKey,
    folderGroups,
    keepEmptyFolders: keepEmpty,
    routeThreadRef,
    parkingRouteThreadKey,
    projectGroups,
    scopedProjectGroups,
    draftCountsByProjectKey,
  } = input;
  const hiddenProjectKeys = useUiStateStore((state) => state.hiddenProjectKeys);
  const routeRowThreadRef =
    routeThreadRef === null
      ? null
      : scopeThreadRef(
          routeThreadRef.environmentId,
          resolveSidebarRowThreadId(routeThreadRef.threadId, routeThreadRef.environmentId, threads),
        );
  const shelfRouteThreadKey =
    routeThreadRef !== null && scopedThreadKey(routeThreadRef) === parkingRouteThreadKey
      ? null
      : routeRowThreadKey;
  // Folders already separate the work, so boring mode has no Working shelf.
  const workingShelfEnabled =
    useClientSettings((s) => s.sidebarWorkingShelfEnabled) && folderGroups === null;
  const inboxReturnsVersion = useSyncExternalStore(
    inboxReturns.subscribe,
    inboxReturns.getSnapshot,
  );
  const nowMinute = useNowMinute();
  // Minute-quantized clocks would delay second-precise snooze wakes by up to a minute.
  const snoozeWakeClock = useSnoozeWakeClock(threads);
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [workingShelfExpanded, setWorkingShelfExpanded] = useLocalStorage(
    WORKING_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  // Shared with the old per-project sidebar, so folders keep their open state.
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const [settledTail, setSettledTail] = useState({
    scopeKey: projectScopeKey,
    count: SETTLED_TAIL_INITIAL_COUNT,
  });
  if (settledTail.scopeKey !== projectScopeKey) {
    setSettledTail({ scopeKey: projectScopeKey, count: SETTLED_TAIL_INITIAL_COUNT });
  }
  const settledVisibleCount =
    settledTail.scopeKey === projectScopeKey ? settledTail.count : SETTLED_TAIL_INITIAL_COUNT;

  const partition = partitionSidebarThreads({
    threads,
    scopedProjectKeys,
    delegatedUnderParent,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    sortActiveBySend: folderGroups !== null,
    routeThreadRef: routeRowThreadRef,
    clockKey: `${nowMinute}:${snoozeWakeClock}:${inboxReturnsVersion}`,
  });
  // Hidden tabs are still searchable, so search reads every visible chat.
  const searchableThreads = filterSidebarV2VisibleThreads(
    threads,
    scopedProjectKeys,
    delegatedUnderParent,
  ).toSorted(
    (left, right) =>
      (right.latestUserMessageAt ?? right.createdAt).localeCompare(
        left.latestUserMessageAt ?? left.createdAt,
      ) || left.id.localeCompare(right.id),
  );

  const { pinnedThreads, activeThreads, workingThreads, snoozedThreads, settledThreads } =
    partition;
  // Older settled threads load in pages; the shelf lists them only as far as they are loaded.
  const olderSettledShelf = useOlderSettledShelf({
    scopes: olderSettledScopes([...serverConfigs.keys()], scopedProjectKeys),
    expanded: settledShelfExpanded,
    visibleCount: settledVisibleCount,
  });
  const listedSettledThreads = settledThreads.filter(olderSettledShelf.isListed);
  useOlderSettledShelfGrowth(olderSettledShelf, listedSettledThreads);
  const settledCount =
    settledThreads.length + olderSettledShelf.unloadedCount(partition.visibleThreads);
  const visibleSettledThreads = (() => {
    const visible = listedSettledThreads.slice(0, settledVisibleCount);
    if (
      routeRowThreadKey !== null &&
      !visible.some((thread) => threadShellKey(thread) === routeRowThreadKey)
    ) {
      const routeThread = settledThreads.find(
        (thread) => threadShellKey(thread) === routeRowThreadKey,
      );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible.length === settledThreads.length ? settledThreads : visible;
  })();
  const renderedSettledThreads = settledShelfExpanded
    ? visibleSettledThreads
    : routeThreadOnly(visibleSettledThreads, shelfRouteThreadKey);
  const visibleSnoozedThreads = snoozedShelfExpanded
    ? snoozedThreads
    : routeThreadOnly(snoozedThreads, shelfRouteThreadKey);
  const visibleWorkingThreads = workingShelfExpanded
    ? workingThreads
    : routeThreadOnly(workingThreads, routeRowThreadKey);
  const projectFolders =
    folderGroups === null
      ? null
      : groupSidebarThreadsByProject(folderGroups, activeThreads, keepEmpty).map((folder) => {
          const collapsed = !resolveProjectExpanded(
            projectExpandedById,
            sidebarFolderExpansionKeys(folder.group),
          );
          return {
            group: folder.group,
            collapsed,
            // A closed folder still shows the open thread, and hints at the rest.
            threads: collapsed
              ? routeThreadOnly(folder.threads, routeRowThreadKey)
              : folder.threads,
            hiddenThreads: collapsed
              ? folder.threads.filter((thread) => threadShellKey(thread) !== routeRowThreadKey)
              : EMPTY_THREADS,
          };
        });
  const projectsInScope = scopedProjectGroups.length === 0 ? projectGroups : scopedProjectGroups;
  const projectSections = Object.fromEntries(
    Object.entries({
      pinned: pinnedThreads,
      active: activeThreads,
      working: visibleWorkingThreads,
      snoozed: visibleSnoozedThreads,
      settled: renderedSettledThreads,
    }).map(([section, rows]) => {
      const grouped = groupSidebarThreadsUnderProjects(rows, projectsInScope);
      return [
        section,
        {
          groups: grouped.groups
            .filter((group) => !hiddenProjectKeys.includes(group.project.projectKey))
            .map((group) => {
              // Each shelf owns its accordion; the old project-only value is
              // a fallback until this shelf is first toggled.
              const expansionKey = `sidebar:${section}:${group.project.projectKey}`;
              const expanded = resolveProjectExpanded(projectExpandedById, [
                expansionKey,
                group.project.projectKey,
              ]);
              return {
                ...group,
                draftProjectKeys: new Set(
                  group.project.memberProjects.map(
                    (project) => `${project.environmentId}:${project.id}`,
                  ),
                ),
                draftCount:
                  section === "active"
                    ? group.project.memberProjects.reduce(
                        (total, project) =>
                          total +
                          (draftCountsByProjectKey.get(`${project.environmentId}:${project.id}`) ??
                            0),
                        0,
                      )
                    : 0,
                expansionKey,
                expanded,
                visibleThreads: expanded
                  ? group.threads
                  : group.threads.filter((thread) => threadShellKey(thread) === routeRowThreadKey),
              };
            }),
          ungrouped: grouped.ungrouped,
        },
      ];
    }),
  );
  const projectKeyByThreadProject = new Map(
    projectGroups.flatMap((project) =>
      project.memberProjectRefs.map(
        (ref) => [`${ref.environmentId}:${ref.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  // Pins are one shared shelf, so they skip project headers but still honor
  // the project scope and hidden projects.
  const threadsForSection = (section: SidebarSection) => {
    if (section === "pinned")
      return pinnedThreads.filter((thread) => {
        const key = projectKeyByThreadProject.get(`${thread.environmentId}:${thread.projectId}`);
        return (
          (scopedProjectGroups.length === 0 ||
            scopedProjectGroups.some((group) => group.projectKey === key)) &&
          (key === undefined || !hiddenProjectKeys.includes(key))
        );
      });
    const grouped = projectSections[section]!;
    return [...grouped.groups.flatMap((group) => group.visibleThreads), ...grouped.ungrouped];
  };
  const mainThreadSection = (thread: EnvironmentThreadShell): SidebarSection => {
    const session = partition.sessionByThreadKey.get(threadShellKey(thread));
    return session && session.chats.length > 1
      ? session.section
      : thread.pinnedAt != null
        ? "pinned"
        : "active";
  };
  const orderedThreads = (["pinned", "active", "working", "snoozed", "settled"] as const).flatMap(
    threadsForSection,
  );
  const sectionByThreadKey = new Map<string, SidebarSection>();
  for (const [list, section] of [
    [pinnedThreads, "pinned"],
    [activeThreads, "active"],
    [workingThreads, "working"],
    [snoozedThreads, "snoozed"],
    [settledThreads, "settled"],
  ] as const) {
    for (const thread of list) sectionByThreadKey.set(threadShellKey(thread), section);
  }
  return {
    ...partition,
    threads,
    workingShelfEnabled,
    searchableThreads,
    settledVisibleCount,
    settledCount,
    olderSettledShelf,
    hiddenSettledCount: Math.max(0, settledCount - visibleSettledThreads.length),
    showMoreSettled: () =>
      setSettledTail((current) => ({
        scopeKey: current.scopeKey,
        count: current.count + SETTLED_TAIL_PAGE_COUNT,
      })),
    settledShelfExpanded,
    toggleSettledShelf: () => setSettledShelfExpanded((value) => !value),
    snoozedShelfExpanded,
    toggleSnoozedShelf: () => setSnoozedShelfExpanded((value) => !value),
    workingShelfExpanded,
    toggleWorkingShelf: () => setWorkingShelfExpanded((value) => !value),
    projectFolders,
    toggleProjectFolder: (group: SidebarProjectSnapshot) => {
      const keys = sidebarFolderExpansionKeys(group);
      setProjectExpanded(keys, !resolveProjectExpanded(projectExpandedById, keys));
    },
    renderedSettledThreads,
    visibleSnoozedThreads,
    visibleWorkingThreads,
    projectSections,
    threadsForSection,
    mainThreadSection,
    orderedThreadKeys: orderedThreads.map(threadShellKey),
    threadByKey: new Map(
      searchableThreads.map((thread) => [threadShellKey(thread), thread] as const),
    ),
    settledThreadKeys: new Set(settledThreads.map(threadShellKey)),
    snoozedThreadKeys: new Set(snoozedThreads.map(threadShellKey)),
    sectionByThreadKey,
    pinnedKeys: threadsForSection("pinned").map(threadShellKey),
    activeKeys: threadsForSection("active")
      .filter((thread) => mainThreadSection(thread) === "active")
      .map(threadShellKey),
    // A strip's row holds the slot of the tab it sorts by, so drops plan
    // between the keys the rows actually show.
    pinnedKeysById: new Map(
      threads.map((thread) => {
        const key = threadShellKey(thread);
        const slot = partition.sortProxyByThreadKey.get(key) ?? thread;
        return [key, slot.pinOrderKey ?? null] as const;
      }),
    ),
    activeKeysById: new Map(
      threads.map((thread) => {
        const key = threadShellKey(thread);
        const slot = partition.sortProxyByThreadKey.get(key) ?? thread;
        return [key, slot.activeOrderKey ?? null] as const;
      }),
    ),
  };
}

function partitionSidebarThreads(input: SidebarThreadPartitionInput) {
  const {
    threads,
    scopedProjectKeys,
    delegatedUnderParent,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    sortActiveBySend,
    routeThreadRef,
  } = input;
  const preciseNow = new Date().toISOString();
  // Children render under their parent, never as independent sidebar sessions.
  const visible = filterSidebarV2VisibleThreads(threads, scopedProjectKeys, delegatedUnderParent);
  const inboxObservation = inboxReturns.observe(workingShelfEnabled ? threads : null);
  const sectionForThread = (thread: EnvironmentThreadShell): WorkspaceChatSection => {
    // A server whose config has not loaded must not strand a session
    // in a shelf the user cannot leave.
    const configLoaded = serverConfigs.has(thread.environmentId);
    const section = resolveSidebarThreadSection({
      snoozed: configLoaded && effectiveSnoozed(thread, { now: preciseNow }),
      settled: configLoaded && thread.settledOverride === "settled",
      pinned: thread.pinnedAt != null,
    });
    return section === "active" && workingShelfEnabled && inboxObservation.isWorking(thread)
      ? "working"
      : section;
  };
  // The route is already resolved to its row thread, so an open subagent
  // keeps its parent chat selected within a grouped workspace.
  const sessions = groupWorkspaceChatSessions(visible, routeThreadRef, sectionForThread);
  const sessionByThreadKey = new Map(
    sessions.map((session) => [threadShellKey(session.thread), session] as const),
  );
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const inbox = (thread: EnvironmentThreadShell, manuallyMoved = false) =>
    workingShelfEnabled &&
    (manuallyMoved ? isThreadWorking(thread) : inboxObservation.isWorking(thread))
      ? working
      : active;
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const draggable = new Set<string>();
  const activeReorderable = new Set<string>();
  const shownBySortProxy = new Map<EnvironmentThreadShell, EnvironmentThreadShell>();
  const sortProxyByThreadKey = new Map<string, EnvironmentThreadShell>();
  const sortProxy = (session: (typeof sessions)[number]) => {
    // A pinned strip sorts by a pinned tab: a fresh failover tab is the
    // latest but has no pin slot, and must not drop the strip out of order.
    const proxy =
      session.section === "pinned" && session.latest.pinnedAt == null
        ? (session.chats.findLast((chat) => chat.pinnedAt != null) ?? session.latest)
        : session.latest;
    if (proxy === session.thread) return session.thread;
    shownBySortProxy.set(proxy, session.thread);
    sortProxyByThreadKey.set(threadShellKey(session.thread), proxy);
    return proxy;
  };
  for (const session of sessions) {
    const thread = session.thread;
    const configLoaded = serverConfigs.has(thread.environmentId);
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (configLoaded) {
      activeReorderable.add(threadKey);
      draggable.add(threadKey);
    }
    if (optimisticDrop?.key === threadKey) {
      const projected = applySidebarThreadDrop(
        thread,
        optimisticDrop.section,
        optimisticDrop.occurredAt,
        optimisticDrop.assignedKeys.get(threadKey),
      );
      (optimisticDrop.section === "pinned"
        ? pinned
        : optimisticDrop.section === "settled"
          ? settled
          : inbox(projected, true)
      ).push(
        optimisticDrop.clearsSnooze
          ? projected
          : { ...projected, snoozedAt: thread.snoozedAt, snoozedUntil: thread.snoozedUntil },
      );
    } else {
      const section = session.section;
      (section === "snoozed"
        ? snoozed
        : section === "settled"
          ? settled
          : section === "pinned"
            ? pinned
            : section === "working"
              ? working
              : active
      ).push(sortProxy(session));
    }
  }
  // Switching tabs must not move a session, so it sorts as its latest tab.
  const shown = (list: readonly EnvironmentThreadShell[]) =>
    list.map((thread) => shownBySortProxy.get(thread) ?? thread);
  // A loaded config gates dragging only; the sort must not depend on it, so web and mobile agree.
  const sortedPinned = shown(sortPinnedThreadsForSidebar(pinned));
  const sortedActive = shown(
    sortActiveBySend
      ? sortWorkingThreadsBySend(active)
      : workingShelfEnabled
        ? sortInboxThreadsByReturn(active, inboxObservation.returnedAt)
        : sortThreadsForSidebar(active),
  );
  return {
    pinnedThreads:
      optimisticDrop?.section !== "pinned" || optimisticDrop.order === null
        ? sortedPinned
        : orderItemsByPreferredIds({
            items: sortedPinned,
            preferredIds: optimisticDrop.order,
            getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          }),
    draggableThreadKeys: draggable,
    activeReorderableThreadKeys: activeReorderable,
    activeThreads:
      optimisticDrop?.section !== "active" || optimisticDrop.order === null
        ? sortedActive
        : orderItemsByPreferredIds({
            items: sortedActive,
            preferredIds: optimisticDrop.order,
            getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          }),
    workingThreads: shown(sortWorkingThreadsBySend(working)),
    snoozedThreads: shown(
      snoozed.toSorted(
        (left, right) =>
          firstValidTimestampMs(left.snoozedUntil ?? null) -
          firstValidTimestampMs(right.snoozedUntil ?? null),
      ),
    ),
    settledThreads: shown(sortSettledThreads(settled)),
    visibleThreads: visible,
    snoozeNow: preciseNow,
    sessionByThreadKey,
    sortProxyByThreadKey,
  };
}

/** The sidebar's scope per environment: the scoped projects there, or every project. */
function olderSettledScopes(
  environmentIds: ReadonlyArray<EnvironmentId>,
  scopedProjectKeys: ReadonlySet<string> | null,
): ReadonlyArray<OlderSettledScope> {
  if (scopedProjectKeys === null) {
    return environmentIds.map((environmentId) => ({ environmentId, projectIds: null }));
  }
  return environmentIds.flatMap((environmentId) => {
    const prefix = `${environmentId}:`;
    const projectIds = [...scopedProjectKeys].flatMap((key) =>
      key.startsWith(prefix) ? [ProjectId.make(key.slice(prefix.length))] : [],
    );
    return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
  });
}

function isOptimisticDropReleased(input: {
  readonly optimisticDrop: SidebarOptimisticDrop;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly pinnedKeys: readonly string[];
  readonly activeKeys: readonly string[];
  readonly now: string;
}): boolean {
  const { optimisticDrop, threads, pinnedKeys, activeKeys, now } = input;
  const canonicalByKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const thread = canonicalByKey.get(optimisticDrop.key);
  if (thread === undefined || thread.archivedAt !== null) {
    return true;
  }
  const canonicalSection = effectiveSnoozed(thread, { now })
    ? "snoozed"
    : thread.settledOverride === "settled"
      ? "settled"
      : thread.pinnedAt != null
        ? "pinned"
        : "active";
  if (
    canonicalSection !== optimisticDrop.sourceSection &&
    canonicalSection !== optimisticDrop.section
  ) {
    return true;
  }
  if (optimisticDrop.order === null) {
    // Settle emits unpin/unsnooze too; hold projected fields and sort times until the whole move completes.
    if (
      canonicalSection === optimisticDrop.section &&
      thread.pinnedAt == null &&
      (!optimisticDrop.clearsSnooze || thread.snoozedUntil == null)
    ) {
      return true;
    }
    return false;
  }
  if (canonicalSection !== optimisticDrop.section) return false;
  if (optimisticDrop.clearsSnooze && thread.snoozedUntil != null) return false;
  const destinationKeys = optimisticDrop.section === "pinned" ? pinnedKeys : activeKeys;
  const canonicalDestination = destinationKeys.flatMap((key) => {
    const canonical = canonicalByKey.get(key);
    return canonical === undefined ? [] : [canonical];
  });
  const keyByThread = new Map(
    canonicalDestination.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      (optimisticDrop.section === "pinned" ? thread.pinOrderKey : thread.activeOrderKey) ?? null,
    ]),
  );
  const heldOrder = optimisticDrop.order;
  const heldKeys = new Set(heldOrder);
  const membershipChanged =
    destinationKeys.length !== heldOrder.length ||
    destinationKeys.some((key) => !heldKeys.has(key));
  const foreignKeyLanded = destinationKeys.some((threadKey) => {
    const currentKey = keyByThread.get(threadKey) ?? null;
    if (currentKey === (optimisticDrop.keysAtDrop.get(threadKey) ?? null)) return false;
    return currentKey !== optimisticDrop.assignedKeys.get(threadKey);
  });
  const allAssignmentsLanded = [...optimisticDrop.assignedKeys].every(
    ([threadKey, orderKey]) => keyByThread.get(threadKey) === orderKey,
  );
  return membershipChanged || foreignKeyLanded || allAssignmentsLanded;
}

// Build maps in a hook so the compiler can prove they are frozen and cache them.
function useSidebarLookups() {
  const projects = useProjects();
  // Activity order lags a running thread's streaming ticks until its next
  // real change; reading every tick re-rendered the whole sidebar with it.
  const threads = useQuietThreadShells();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  // Activity only reorders sessions within a project. The roster uses the
  // persisted project order; picker/command-palette ordering stays configurable.
  const projectGroups = buildSidebarProjectSnapshots({
    projects: orderedProjects,
    groupScratchProjects: true,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
  });
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const projectDisplayNameByKey = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );
  const projectGroupByScopeKey = new Map(
    projectGroups.map((project) => [project.projectKey, project] as const),
  );
  const projectKeyByThreadProject = new Map(
    projectGroups.flatMap((project) =>
      project.memberProjectRefs.map(
        (ref) => [`${ref.environmentId}:${ref.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const delegatedUnderParent = useDelegatedUnderParent();
  const projectScopeItems = [
    { value: "all", label: "All projects" },
    ...sortSidebarV2ProjectGroups(
      projectGroups,
      threads,
      sidebarProjectSortOrder,
      delegatedUnderParent,
    ).map((project) => ({ value: project.projectKey, label: project.displayName })),
  ];
  return {
    projects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
    projectGroupByScopeKey,
    projectKeyByThreadProject,
    projectScopeItems,
    sidebarProjectSortOrder,
  };
}

function ProjectScopeRowIcon(props: { isSelected: boolean; children: ReactNode }) {
  return (
    <span className="relative flex shrink-0">
      {props.children}
      {props.isSelected ? (
        <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-primary ring-2 ring-popover">
          <CheckIcon className="size-2 text-primary-foreground" strokeWidth={4} aria-hidden />
        </span>
      ) : null}
    </span>
  );
}

function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}

function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more selected threads.",
  });
  return false;
}

const SIDEBAR_DRAG_DISTANCE = 6;

const threadSearchResultId = (index: number) => `sidebar-thread-search-result-${index}`;

// Continuations that outlive a render read the open thread from the router.
function readRouteThreadKey(router: AnyRouter): string | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  const ref = resolveActiveThreadRouteRef(target, draft);
  return ref === null ? null : scopedThreadKey(ref);
}

export default function Sidebar({ routeReveal }: { routeReveal: SidebarRouteReveal }) {
  const {
    projects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
    projectGroupByScopeKey,
    projectKeyByThreadProject,
    projectScopeItems,
    sidebarProjectSortOrder,
  } = useSidebarLookups();
  const delegatedUnderParent = useDelegatedUnderParent();
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const hiddenProjectKeys = useUiStateStore((state) => state.hiddenProjectKeys);
  const setProjectHidden = useUiStateStore((state) => state.setProjectHidden);
  const setProjectOrder = useUiStateStore((state) => state.setProjectOrder);
  const hiddenProjectGroups = projectGroups.filter((group) =>
    hiddenProjectKeys.includes(group.projectKey),
  );
  // Dropping a header pins the order the user sees, so a drag switches the
  // project sort to manual.
  const handleProjectDrop = (
    draggedProjectKey: string,
    targetProjectKey: string,
    position: SidebarProjectDropPosition,
  ) => {
    const dragged = projectGroups.find((group) => group.projectKey === draggedProjectKey);
    if (!dragged) return;
    const reordered = projectGroups.filter((group) => group !== dragged);
    const targetIndex = reordered.findIndex((group) => group.projectKey === targetProjectKey);
    if (targetIndex < 0) return;
    reordered.splice(position === "before" ? targetIndex : targetIndex + 1, 0, dragged);
    setProjectOrder(
      reordered.flatMap((group) => group.memberProjects.map((member) => member.physicalProjectKey)),
    );
    if (sidebarProjectSortOrder !== "manual") {
      updateClientSettings({ sidebarProjectSortOrder: "manual" });
    }
  };
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    reorderPinnedThread,
    reorderActiveThread,
    markThreadUnread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const boringSidebarEnabled = useBoringSidebarEnabled();
  const folderRowsMultiline = useClientSettings((settings) => settings.boringSidebarMultilineRows);
  const newThreadContext = useHandleNewThread();
  // Row callbacks capture only the handler; the rest of the context changes with the route.
  const { handleNewThread } = newThreadContext;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const environmentMachineById = useEnvironmentMachines();
  const projectGroupsRef = useRef(projectGroups);
  const persistedProjectScopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const setPersistedProjectScopeKeys = useUiStateStore((store) => store.setSidebarProjectScopeKeys);
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  const allProjectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const allProjectConfigsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  const headerSearchRef = useRef<HTMLDivElement | null>(null);
  // Safari may click after Ctrl+click opens settings; suppress that selection until the picker reopens.
  const suppressNextScopeChangeRef = useRef(false);
  const highlightedProjectScopeKeyRef = useRef<string | null>(null);
  // Hold dropped rows until server placement is confirmed; block another pickup from replacing the hold.
  const [optimisticDrop, setOptimisticDrop] = useState<SidebarOptimisticDrop | null>(null);
  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [searchHighlightKey, setSearchHighlightKey] = useState<string | null>(null);
  const searchEnvironmentIds = useConnectedEnvironmentIds();
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const [renamingThreadRef, setRenamingThreadRef] = useState<ScopedThreadRef | null>(null);
  const canOperateRenamingThread = useEnvironmentScope(
    renamingThreadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  // Losing operate access cancels the rename without committing the title, so
  // the editor does not return and take focus when access comes back.
  if (renamingThreadRef !== null && !canOperateRenamingThread) setRenamingThreadRef(null);
  const renamingThreadKey =
    renamingThreadRef !== null && canOperateRenamingThread
      ? scopedThreadKey(renamingThreadRef)
      : null;
  const [renamingTitle, setRenamingTitle] = useState("");
  const settlingThreadKeysRef = useRef(new Set<string>());
  const threadListRef = useRef<HTMLUListElement | null>(null);
  const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const [dragState, setDragState] = useState<{
    readonly activeKey: string;
    readonly activeSection: SidebarSection;
    readonly occurredAt: string;
    readonly activationY: number | null;
    readonly targetSection: SidebarSection | null;
    readonly contextDrag: boolean;
  } | null>(null);
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
  const contextDragKeyRef = useRef<string | null>(null);
  const [actionSweep, setActionSweep] = useState<{
    action: SidebarSweepAction;
    keys: ReadonlySet<string>;
  } | null>(null);
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const openAddProjectCommandPalette = () => openCommandPalette({ open: "add-project" });
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  // The open thread while settle or snooze moves you off it. Collapsed
  // shelves reveal the open thread, so without this its row would slide into
  // the shelf, then vanish when the forward navigation lands a moment later.
  // Cleared once the route moves on, or by the caller when the park fails.
  const [parkingRouteThreadKey, setParkingRouteThreadKey] = useState<string | null>(null);
  if (parkingRouteThreadKey !== null && parkingRouteThreadKey !== routeThreadKey) {
    setParkingRouteThreadKey(null);
  }

  // A selection made under one scope can hold threads the next scope hides.
  const setProjectScopeKeys = (keys: readonly string[]) => {
    clearSelection();
    setPersistedProjectScopeKeys(keys);
  };
  // A scope whose project is gone reads as all projects once every snapshot has
  // loaded. The stored keys are left alone, so the scope returns with its project.
  const chosenProjectScopeKeys = resolveSidebarProjectScopeKeys({
    groups: projectGroups,
    keys: persistedProjectScopeKeys,
    settings: projectGroupingSettings,
    canClearMissingScope: allProjectSnapshotsReady && allProjectConfigsReady,
  });
  const chosenProjectGroups = projectGroups.filter((project) =>
    chosenProjectScopeKeys.includes(project.projectKey),
  );
  const chosenScopeProjectKeys =
    chosenProjectGroups.length === 0
      ? null
      : new Set(
          chosenProjectGroups.flatMap((project) =>
            project.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
        );
  const threads = useQuietThreadShells();
  const routeRowThreadKey =
    routeThreadRef === null
      ? null
      : scopedThreadKey(
          scopeThreadRef(
            routeThreadRef.environmentId,
            resolveSidebarRowThreadId(
              routeThreadRef.threadId,
              routeThreadRef.environmentId,
              threads,
            ),
          ),
        );
  const isSearchingThreads = threadSearchQuery.trim().length > 0;

  // History, the palette and links can open a thread the scope hides or the list
  // scrolled away; a remount starts at the top, so each mount scrolls to the open
  // thread once. Render decides the widening, so the first frame of the new route
  // already lists the row; the active row's ref callback scrolls to it.
  const { widensScope: revealWidensScope } = resolveSidebarRouteReveal({
    reveal: routeReveal,
    routeKey: routeRowThreadKey,
    isSearching: isSearchingThreads,
    scopedProjectKeys: chosenScopeProjectKeys,
    delegatedUnderParent,
    findThread: (key) => threads.find((candidate) => threadShellKey(candidate) === key),
  });
  const projectScopeKeys = revealWidensScope ? [] : chosenProjectScopeKeys;
  const projectScopeKey = projectScopeKeys.length === 0 ? null : projectScopeKeys.join("\n");
  const toggleProjectScopeKey = (key: string) =>
    setProjectScopeKeys(
      projectScopeKeys.includes(key)
        ? projectScopeKeys.filter((candidate) => candidate !== key)
        : [...projectScopeKeys, key],
    );
  // The widened scope outlives the reveal, so it is written back to the persisted
  // scope. Route changes arrive from history, links and the palette, and only this
  // component holds the project groups that decide a widening, so no single
  // navigation handler can make the write.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes a route reveal's widened project scope back to the persisted sidebar scope and clears selection
  useEffect(() => {
    if (!revealWidensScope) return;
    clearSelection();
    setPersistedProjectScopeKeys([]);
  }, [clearSelection, revealWidensScope, setPersistedProjectScopeKeys]);
  const revealActiveRow = useActiveRowReveal(routeReveal, routeRowThreadKey);
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const scratchMachineLabelFor = (
    thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">,
  ) => {
    if (!showProjectEnvironments) return null;
    const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
    if (
      !project ||
      !isScratchProject(project, serverConfigs.get(thread.environmentId)?.scratchWorkspaceRoot)
    ) {
      return null;
    }
    return environmentLabelById.get(thread.environmentId) ?? null;
  };
  const selectedProjectScopeItem =
    projectScopeKeys.length > 1
      ? null
      : (projectScopeItems.find((item) => item.value === (projectScopeKeys[0] ?? "all")) ??
        projectScopeItems[0]!);
  const filteredProjectScopeItems = filterSidebarProjectScopeItems({
    items: projectScopeItems,
    query: projectScopeMenuState.query,
    matches: (item, query) =>
      projectScopeFilter.contains(item, query, (candidate) => candidate.label),
  });
  const scopedProjectGroups = revealWidensScope ? [] : chosenProjectGroups;
  const scopedProjectRefs = scopedProjectGroups.flatMap((project) => project.memberProjectRefs);
  const scopedProjectKeys = revealWidensScope ? null : chosenScopeProjectKeys;
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    threadSearchQuery,
    scopedProjectGroups.length === 0
      ? {}
      : { projectIds: scopedProjectRefs.map((projectRef) => projectRef.projectId) },
  );
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  // Subscribe to membership counts, not prompt text. Project counts and the
  // empty state only re-render when a draft enters or leaves the list.
  const draftCountsByProjectKey = useComposerDraftStore(
    useShallow((store) =>
      countSidebarDraftSessions(store, {
        routeDraftId: routeDraftIdForRows,
        scopedProjectKeys,
      }),
    ),
  );
  const knownProjectKeys = new Set(projectByKey.keys());
  const hiddenDraftProjectKeys = new Set(
    hiddenProjectGroups.flatMap((group) =>
      group.memberProjects.map((project) => `${project.environmentId}:${project.id}`),
    ),
  );
  const visibleDraftSessionCount = [...draftCountsByProjectKey].reduce(
    (total, [key, count]) => total + (hiddenDraftProjectKeys.has(key) ? 0 : count),
    0,
  );

  const openProjectSettings = useStableCallback(
    (projectGroup: SidebarProjectSnapshot, projectRef?: ScopedProjectRef) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: {
          projectKey: getSidebarProjectSettingsKey(
            projectGroup,
            projectGroupingSettings,
            projects,
            projectRef,
          ),
        },
      });
    },
  );
  const handleProjectSettings = useStableCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      suppressNextScopeChangeRef.current = true;
      dispatchProjectScopeMenu({ type: "project-settings-opened" });
      openProjectSettings(projectGroup);
    },
  );
  const startThreadInProjectFolder = useStableCallback((group: SidebarProjectSnapshot) => {
    if (isMobile) setOpenMobile(false);
    void handleNewThread(scopeProjectRef(group.environmentId, group.id));
  });
  const handleProjectFolderContextMenu = useStableCallback(
    (group: SidebarProjectSnapshot, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      void (async () => {
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              { id: "new-thread", label: "New thread" },
              { id: "copy-path", label: "Copy path" },
              { id: "project-settings", label: "Project settings", icon: "settings" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "new-thread":
            startThreadInProjectFolder(group);
            return;
          case "copy-path":
            copyPathToClipboard(group.workspaceRoot, { path: group.workspaceRoot });
            return;
          case "project-settings":
            openProjectSettings(group);
            return;
        }
      })();
    },
  );

  const {
    workingShelfEnabled,
    pinnedThreads,
    draggableThreadKeys,
    activeReorderableThreadKeys,
    activeThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
    snoozeNow,
    searchableThreads,
    settledVisibleCount,
    settledCount,
    olderSettledShelf,
    hiddenSettledCount,
    showMoreSettled,
    settledShelfExpanded,
    toggleSettledShelf,
    snoozedShelfExpanded,
    toggleSnoozedShelf,
    workingShelfExpanded,
    toggleWorkingShelf,
    projectFolders,
    toggleProjectFolder,
    renderedSettledThreads,
    threadsForSection,
    projectSections,
    mainThreadSection,
    orderedThreadKeys,
    threadByKey,
    settledThreadKeys,
    snoozedThreadKeys,
    sectionByThreadKey,
    pinnedKeys,
    activeKeys,
    pinnedKeysById,
    activeKeysById,
    sessionByThreadKey,
  } = useSidebarThreads({
    projectScopeKey,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    projectGroups,
    scopedProjectGroups,
    routeThreadRef,
    parkingRouteThreadKey,
    draftCountsByProjectKey,
    threads,
    delegatedUnderParent,
    routeRowThreadKey,
    // Fork (Owner): project headers group every section, so boring mode's folders stay off.
    folderGroups: null,
    keepEmptyFolders: scopedProjectGroups.length > 0,
  });

  // Ranked across environments as the palette ranks them, so one
  // environment's list does not sit above another's better matches; rows
  // already shown keep their places while slower environments answer.
  const threadByMatchKey =
    threadSearch.matches.length === 0
      ? null
      : new Map(
          searchableThreads.map((thread) => [
            threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
            thread,
          ]),
        );
  const rankedServerMatches =
    threadByMatchKey === null
      ? []
      : rankMessageMatches(
          threadSearch.matches,
          (match) => {
            const thread = threadByMatchKey.get(threadSearchMatchKey(match));
            return thread ? threadSearchSubject(thread, null) : undefined;
          },
          foldSearchQuery(threadSearchQuery),
          // oxlint-disable-next-line react/purity -- Recency ranking samples the clock when the search matches change; the compiler recomputes it only then.
          Date.now(),
          // A list filter, as on mobile: a pick would move rows unexplained.
          { picks: false },
        );
  const serverMatchByKey = new Map(
    rankedServerMatches.map((match) => [threadSearchMatchKey(match), match] as const),
  );
  const [shownMessageOrder, setShownMessageOrder] = useState<ShownOrder | null>(null);
  const messageOrder = nextShownOrder(
    shownMessageOrder,
    threadSearch.query,
    [...serverMatchByKey.keys()],
    Number.POSITIVE_INFINITY,
  );
  if (messageOrder !== shownMessageOrder) setShownMessageOrder(messageOrder);
  const { titleMatches: threadTitleResults, contentMatches: threadContentResults } =
    searchSidebarThreads(searchableThreads, threadSearchQuery, new Set(messageOrder.keys));
  const threadSearchResults = [...threadTitleResults, ...threadContentResults];
  // Only rows listed for their messages show one, and open find on it.
  const threadSearchMatchByKey = new Map(
    threadContentResults.flatMap((thread) => {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      const match = serverMatchByKey.get(key);
      return match ? [[key, match] as const] : [];
    }),
  );
  const threadSearchResultKeys = threadSearchResults.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );

  // The highlight follows its thread, so rows that arrive late do not move
  // it under Enter; a new query starts at the top.
  const activeSearchResultIndex = Math.max(
    0,
    searchHighlightKey === null ? 0 : threadSearchResultKeys.indexOf(searchHighlightKey),
  );
  const setActiveSearchResultIndex = (index: number | ((index: number) => number)) =>
    setSearchHighlightKey(
      threadSearchResultKeys[
        typeof index === "function" ? index(activeSearchResultIndex) : index
      ] ?? null,
    );
  const moveSearchHighlight = (step: 1 | -1) => {
    const count = threadSearchResults.length;
    setActiveSearchResultIndex((activeSearchResultIndex + step + count) % count);
  };

  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  // Read changing maps/sets through refs so streamed events preserve row callbacks.
  const threadByKeyRef = useRef(threadByKey);
  const settledThreadKeysRef = useRef(settledThreadKeys);
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);

  const jumpLabelByKey = (() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  })();

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const handleThreadFileDrop = async (threadRef: ScopedThreadRef, files: File[]) => {
    const dropId = queuePendingFileDrop({ threadRef, files });
    const landedBefore =
      router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname === router.state.location.pathname;
    if (landedBefore) return;

    try {
      await navigateToThread(threadRef);
      const landed =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (!landed) clearPendingFileDrop(dropId);
    } catch {
      clearPendingFileDrop(dropId);
    }
  };

  const navigateToDraft = (draftId: DraftId) => {
    clearSelection();
    if (isMobile) {
      setOpenMobile(false);
    }
    void router.navigate({ to: "/draft/$draftId", params: { draftId } });
  };

  const clearThreadSearch = () => {
    setThreadSearchQuery("");
    setSearchHighlightKey(null);
  };
  const selectThreadSearchResult = (thread: EnvironmentThreadShell) => {
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    // A row listed for a message match opens find on it, as the palette does.
    const match = threadSearchMatchByKey.get(
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
    );
    const query = threadSearch.query;
    clearThreadSearch();
    navigateToThread(ref);
    if (match) openThreadFindOnQuery(scopedThreadKey(ref), findForMessageMatch(match, query));
  };
  const handleThreadSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearchingThreads) {
      event.preventDefault();
      event.stopPropagation();
      clearThreadSearch();
      return;
    }
    if (threadSearchResults.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSearchHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSearchHighlight(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = threadSearchResults[activeSearchResultIndex];
      if (result) selectThreadSearchResult(result);
    }
  };

  const startThreadRename = (threadRef: ScopedThreadRef, title: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    setRenamingThreadRef(threadRef);
    setRenamingTitle(title);
  };
  const cancelThreadRename = () => setRenamingThreadRef(null);
  const commitThreadRename = (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
    void (async () => {
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      const trimmed = title.trim();
      setRenamingThreadRef(null);
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (trimmed === originalTitle) return;
      const result = await updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, title: trimmed },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleThreadClick = (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
    if (isSidebarNestedLinkClick(event.target)) return;
    const isMac = isMacPlatform(navigator.platform);
    const isModClick = isMac ? event.metaKey : event.ctrlKey;
    const threadKey = scopedThreadKey(threadRef);
    if (isModClick) {
      event.preventDefault();
      toggleThreadSelection(threadKey);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      rangeSelectTo(threadKey, orderedThreadKeysRef.current);
      return;
    }
    if (isTrailingDoubleClick(event.detail)) {
      return;
    }
    navigateToThread(threadRef);
  };

  // Snapshot navigation before partition mutation; background parks use a null plan.
  const planForwardNavigation = (
    threadKey: string,
    coParkingKeys?: ReadonlySet<string>,
  ): (() => void) | null => {
    if (readRouteThreadKey(router) !== threadKey) return null;
    setParkingRouteThreadKey(threadKey);
    const shell = threadByKeyRef.current.get(threadKey);
    const orderedKeys = orderedThreadKeysRef.current;
    const settledKeys = settledThreadKeysRef.current;
    const snoozedKeys = snoozedThreadKeysRef.current;
    const currentIndex = orderedKeys.indexOf(threadKey);
    const nextCardKey =
      currentIndex === -1
        ? null
        : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
            (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
          ) ?? null);
    const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
    return nextThread
      ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
      : shell
        ? () => void handleNewThread(scopeProjectRef(shell.environmentId, shell.projectId))
        : () => void router.navigate({ to: "/" });
  };
  // For a park that leaves you on the thread: it failed, or you moved first.
  const releaseParkingRouteThread = (threadKey: string) => {
    setParkingRouteThreadKey((current) => (current === threadKey ? null : current));
  };

  const attemptSettle = (
    threadRef: ScopedThreadRef,
    opts: { coSettlingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const threadKey = scopedThreadKey(threadRef);
      if (settlingThreadKeysRef.current.has(threadKey)) return;
      settlingThreadKeysRef.current.add(threadKey);
      const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
      const result = await settleThread(threadRef);
      settlingThreadKeysRef.current.delete(threadKey);
      if (result._tag === "Failure") {
        releaseParkingRouteThread(threadKey);
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (
        shouldNavigateAfterThreadPark({
          threadKey,
          currentThreadKey: readRouteThreadKey(router),
          action: "settle",
          now: new Date().toISOString(),
          thread: readThreadShell(threadRef),
        })
      ) {
        navigateAfterSettle?.();
      } else {
        releaseParkingRouteThread(threadKey);
      }
    })();
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this sidebar's settle handler in the module-level settleAndAdvance registry
  useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
  const settleThreads = (threadKeys: readonly string[]) => {
    const coSettlingKeys = new Set(threadKeys);
    for (const threadKey of threadKeys) {
      const thread = threadByKeyRef.current.get(threadKey);
      if (!thread || thread.settledOverride === "settled") continue;
      attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
    }
  };
  const attemptUnsettle = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsettleThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnsnooze = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsnoozeThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  // A new array re-renders DndContext and with it every sortable row.
  const dndModifiers = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];
  const attachListMotionRef = (node: HTMLUListElement) => {
    threadListRef.current = node;
    const motion = createSidebarListMotion(node);
    listMotionRef.current = motion;
    motion.update(false);
    return () => {
      // Search replaces this list while the Sidebar stays mounted, and a drag
      // whose rows are gone can never drop. The compiler memoizes this callback
      // with no deps (it reads only refs), so the cleanup runs only on unmount.
      dragSensorRef.current?.cancel();
      motion.dispose();
      if (listMotionRef.current === motion) listMotionRef.current = null;
      if (threadListRef.current === node) threadListRef.current = null;
    };
  };

  const attachTreeRef = (node: HTMLUListElement) => {
    const detachMotion = attachListMotionRef(node);
    const detachTree = attachSidebarTree(node);
    return () => {
      detachTree?.();
      detachMotion();
    };
  };

  const isContextDrag = dragState?.contextDrag === true || dragState?.activeSection === "working";
  const dragTargetSection = isContextDrag ? null : (dragState?.targetSection ?? null);
  const finishThreadDrag = (started: boolean) => {
    const activeKey = contextDragKeyRef.current;
    dragSensorRef.current = null;
    contextDragKeyRef.current = null;
    endThreadContextDrag();
    if (started) {
      // The source row animates from where the drop slot showed it.
      const list = threadListRef.current;
      const source =
        list && activeKey
          ? list.querySelector<HTMLElement>(
              `[data-thread-item="${globalThis.CSS.escape(activeKey)}"]`,
            )
          : null;
      const slot = list?.querySelector<HTMLElement>('[data-testid="sidebar-drop-slot"]');
      listMotionRef.current?.release(
        source && slot ? { node: source, top: slot.getBoundingClientRect().top } : undefined,
      );
      setDragState(null);
    }
  };
  const attachDragSensor = (sensor: SidebarPointerSensor) => {
    dragSensorRef.current = sensor;
  };
  const cancelThreadDrag = () => {
    dragSensorRef.current?.cancel();
  };
  const contextDragThreads = (): ReadonlyArray<ScopedThreadRef> => {
    const key = contextDragKeyRef.current;
    if (key === null) return [];
    const selected = useThreadSelectionStore.getState().selectedThreadKeys;
    const keys = selected.has(key) ? [...selected] : [key];
    return keys.flatMap((candidate) => {
      const ref = parseScopedThreadKey(candidate);
      return ref ? [ref] : [];
    });
  };
  const pointerOutsideThreadList = (point: { x: number; y: number }) => {
    const bounds = threadListRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  };
  const moveThreadContextDrag = (point: { x: number; y: number }) => {
    const contextDrag = pointerOutsideThreadList(point);
    setDragState((current) =>
      current === null || current.contextDrag === contextDrag
        ? current
        : { ...current, contextDrag },
    );
    if (!contextDrag) {
      endThreadContextDrag();
      return false;
    }
    const threads = contextDragThreads();
    const title =
      threadByKeyRef.current.get(contextDragKeyRef.current ?? "")?.title.trim() || "Thread";
    moveThreadContextDragGhost(point, { title, count: threads.length });
    return true;
  };
  const dropThreadContextDrag = (point: { x: number; y: number }) => {
    if (!pointerOutsideThreadList(point)) return false;
    dropThreadContext(point, contextDragThreads());
    return true;
  };
  // useSensor memoizes options identity; fresh options rebuild DndContext and every sortable row.
  const pointerSensorOptions = {
    distance: SIDEBAR_DRAG_DISTANCE,
    onAttach: attachDragSensor,
    onFinish: finishThreadDrag,
    onMove: moveThreadContextDrag,
    onDrop: dropThreadContextDrag,
  };
  const dndSensors = useSensors(useSensor(SidebarPointerSensor, pointerSensorOptions));
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed list data to refs read by stable drag and sweep callbacks
  useLayoutEffect(() => {
    projectGroupsRef.current = projectGroups;
    orderedThreadKeysRef.current = orderedThreadKeys;
    threadByKeyRef.current = threadByKey;
    settledThreadKeysRef.current = settledThreadKeys;
    snoozedThreadKeysRef.current = snoozedThreadKeys;
    sectionByThreadKeyRef.current = sectionByThreadKey;
  });
  const startActionSweep = useStableCallback(
    (threadRef: ScopedThreadRef, action: SidebarSweepAction, event: PointerEvent) => {
      const originKey = scopedThreadKey(threadRef);
      const originSection = sectionByThreadKeyRef.current.get(originKey);
      const canApply = (key: string) => {
        const thread = threadByKeyRef.current.get(key);
        return (
          thread !== undefined &&
          sectionByThreadKeyRef.current.get(key) === originSection &&
          serverConfigs.has(thread.environmentId)
        );
      };
      let targetKey: string | null = null;
      let sweptKeys: string[] = [];
      const sweepTo = (key: string | null) => {
        if (key === null || key === targetKey) return;
        targetKey = key;
        sweptKeys = resolveSidebarSweepKeys(orderedThreadKeysRef.current, originKey, key, canApply);
        setActionSweep({ action, keys: new Set(sweptKeys) });
      };
      dragSensorRef.current = new SidebarPointerSensor({
        active: originKey,
        event,
        options: {
          distance: SIDEBAR_DRAG_DISTANCE,
          onAttach: () => {},
          onFinish: () => {
            dragSensorRef.current = null;
            setActionSweep(null);
          },
        },
        onPending: () => {},
        onStart: () => sweepTo(originKey),
        onMove: ({ y }) =>
          sweepTo(threadListRef.current && sidebarThreadKeyAtY(threadListRef.current, y)),
        onEnd: () => {
          const keys = sweptKeys.filter(canApply);
          if (action === "settle") {
            settleThreads(keys);
            return;
          }
          for (const key of keys) {
            const ref = parseScopedThreadKey(key);
            if (ref === null) continue;
            if (action === "unsettle") attemptUnsettle(ref);
            else attemptUnsnooze(ref);
          }
        },
        onCancel: () => {},
        onAbort: () => {},
      });
    },
  );
  // Release during render when server state catches up so canonical order appears in the same frame.
  if (
    optimisticDrop !== null &&
    isOptimisticDropReleased({
      optimisticDrop,
      threads,
      pinnedKeys,
      activeKeys,
      now: snoozeNow,
    })
  ) {
    setOptimisticDrop(null);
  }
  const attemptPin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await pinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to pin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnpin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await confirmAndUnpinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unpin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleThreadDragStart = (event: DragStartEvent) => {
    const activeKey = String(event.active.id);
    contextDragKeyRef.current = activeKey;
    const activeSection = sectionByThreadKey.get(activeKey);
    if (activeSection === undefined) return;
    listMotionRef.current?.suspend();
    setDragState({
      activeKey,
      activeSection,
      targetSection: activeSection,
      contextDrag: false,
      occurredAt: new Date().toISOString(),
      activationY:
        event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
    });
  };
  const hasProjectFolders = projectFolders !== null && projectFolders.length > 0;
  const sidebarListItemsFresh = ((): readonly SidebarListItem[] => {
    const rowsOf = (section: SidebarSection): SidebarListItem[] => {
      const grouped = projectSections[section]!;
      const row = (thread: EnvironmentThreadShell): SidebarListItem => ({
        kind: "thread",
        key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        section,
        projectKey: projectKeyByThreadProject.get(`${thread.environmentId}:${thread.projectId}`),
      });
      if (section === "pinned") return threadsForSection("pinned").map(row);
      return [
        ...grouped.groups.flatMap((group): SidebarListItem[] => [
          {
            kind: "project",
            key: sidebarProjectHeaderId(section, group.project.projectKey),
            projectKey: group.project.projectKey,
            section,
            expanded: group.expanded,
            threadCount: group.threads.length + group.draftCount,
            visible: section === "active" || group.threads.length > 0,
          },
          ...(section === "active"
            ? [
                {
                  kind: "marker" as const,
                  marker: "active-placeholder" as const,
                  projectKey: group.project.projectKey,
                },
                {
                  kind: "marker" as const,
                  marker: "draft-block" as const,
                  projectKey: group.project.projectKey,
                },
              ]
            : []),
          ...group.visibleThreads.map(row),
        ]),
        ...grouped.ungrouped.map(row),
      ];
    };
    const items: SidebarListItem[] = [];
    const activeRows = rowsOf("active");
    items.push({ kind: "marker", marker: "pinned-header", sharedPins: true });
    items.push(...rowsOf("pinned"));
    items.push({ kind: "marker", marker: "pinned-placeholder" });
    items.push({ kind: "marker", marker: "pinned-divider" });
    items.push({ kind: "marker", marker: "active-placeholder" });
    items.push(...activeRows);
    if (workingThreads.length > 0) {
      items.push({ kind: "marker", marker: "working-header" });
      items.push(...rowsOf("working"));
    }
    if (snoozedThreads.length > 0) {
      items.push({ kind: "marker", marker: "snoozed-header" });
      items.push(...rowsOf("snoozed"));
    }
    items.push({ kind: "marker", marker: "settled-header" });
    const settledRows = rowsOf("settled");
    items.push({ kind: "marker", marker: "settled-placeholder" });
    items.push(...settledRows);
    return items;
  })();
  // Preserve the list while streamed updates leave order unchanged to retain row memoization.
  const sidebarListItemsKey = sidebarListItemsFresh
    .map((item) => (item.kind === "marker" ? item.marker : item.section + ":" + item.key))
    .join("\n");
  const [sidebarListItemsState, setSidebarListItems] = useState(sidebarListItemsFresh);
  const [sidebarListItemsKeyState, setSidebarListItemsKeyState] = useState(sidebarListItemsKey);
  let sidebarListItems = sidebarListItemsState;
  if (sidebarListItemsKeyState !== sidebarListItemsKey) {
    setSidebarListItemsKeyState(sidebarListItemsKey);
    setSidebarListItems(sidebarListItemsFresh);
    // Update the local list too; threadByKey already omits rows moved into collapsed shelves.
    sidebarListItems = sidebarListItemsFresh;
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the dnd-kit drag sensor when the dragged row leaves the list
  useEffect(() => {
    if (
      dragState !== null &&
      !sidebarListItems.some((item) => item.kind === "thread" && item.key === dragState.activeKey)
    ) {
      cancelThreadDrag();
    }
  }, [cancelThreadDrag, dragState, sidebarListItems]);
  // Only order, section, or draft changes need layout reads and motion.
  const listMotionLayoutKey = [
    sidebarListItemsKey,
    projectFolders
      ?.map((folder) => `${folder.group.projectKey}:${folder.threads.length}`)
      .join("\n") ?? "",
    visibleDraftSessionCount,
    routeDraftIdForRows ?? "",
  ].join("\0");
  const listMotionAnimate =
    dragState === null && sidebarListItems.length + visibleDraftSessionCount > 0;
  // Cache on both fields so layout-key changes trigger the effect even when animate is unchanged.
  const listMotionPass = { layoutKey: listMotionLayoutKey, animate: listMotionAnimate };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list motion controller to animate or not after each layout-affecting commit
  useLayoutEffect(() => {
    listMotionRef.current?.update(listMotionPass.animate);
  }, [listMotionPass]);
  const handleThreadDragOver = (event: DragOverEvent) => {
    const target = event.over
      ? resolveSidebarDropTarget(sidebarListItems, String(event.active.id), String(event.over.id))
      : null;
    setDragState((current) =>
      current === null || current.activeKey !== String(event.active.id)
        ? current
        : { ...current, targetSection: target?.section ?? null },
    );
  };
  const sortableIds = sidebarListItems.map(sidebarListItemId);
  // Keep non-drag orders constant to preserve sorting strategy and row identity during streaming.
  const { settledOrder: draggedSettledOrder, activeOrder: draggedActiveOrder } =
    dragState === null
      ? NO_DRAGGED_ORDERS
      : resolveDraggedOrders({
          drag: dragState,
          threadByKey,
          settledThreads,
          activeThreads,
          sessionByThreadKey,
          workingShelfEnabled,
        });
  const sidebarSortingStrategy = createSidebarSortingStrategy({
    items: sidebarListItems,
    enabled: !isContextDrag,
    boundaryLabelHeight: 0,
    includeActiveSlot: true,
    settledOrder: draggedSettledOrder,
    ...(draggedActiveOrder === undefined ? {} : { activeOrder: draggedActiveOrder }),
    settledExpanded: settledShelfExpanded,
    settledVisibleCount,
    routeThreadKey: routeRowThreadKey,
    snoozedThreadCount: snoozedThreads.length,
  });
  // Active reorders only renumber neighbours inside the source project.
  const projectThreadKeysFor = (projectKey: string | undefined) =>
    new Set(
      sidebarListItems.flatMap((item) =>
        item.kind === "thread" && item.projectKey === projectKey ? [item.key] : [],
      ),
    );
  const draggedThreadKey = dragState?.activeKey;
  const draggedFromSection = dragState?.activeSection;
  const dragActivationY = dragState?.activationY;
  const dndCollisionDetection = (() => {
    if (draggedThreadKey === undefined || draggedFromSection === undefined)
      return createSidebarCollisionDetection(() => true);
    const source = threadByKey.get(draggedThreadKey);
    if (source === undefined) return createSidebarCollisionDetection(() => false);
    const sourceProjectKey = projectKeyByThreadProject.get(
      `${source.environmentId}:${source.projectId}`,
    );
    const sourceProjectThreadKeys = projectThreadKeysFor(sourceProjectKey);
    return createSidebarCollisionDetection(
      (id) => {
        const target = resolveSidebarDropTarget(sidebarListItems, draggedThreadKey, id);
        if (target === null) return false;
        // Rows only reorder within their own shelf, or move into Pins.
        if (
          target.section !== "pinned" &&
          target.section !== (draggedFromSection === "pinned" ? "active" : draggedFromSection)
        )
          return false;
        const overThread = threadByKey.get(id);
        const overProject = sidebarListItems.find(
          (item) => item.kind === "project" && item.key === id,
        );
        // Only the shared Pins shelf accepts rows from another project.
        if (
          target.section !== "pinned" &&
          (overThread || overProject?.kind === "project") &&
          sourceProjectKey !==
            (overProject?.kind === "project"
              ? overProject.projectKey
              : overThread &&
                projectKeyByThreadProject.get(
                  `${overThread.environmentId}:${overThread.projectId}`,
                ))
        )
          return false;
        return (
          planSidebarThreadDrop({
            activeKey: draggedThreadKey,
            activeSection: draggedFromSection,
            activePinned: draggedFromSection === "pinned" || source.pinnedAt != null,
            activeSettled: source.settledOverride === "settled",
            supportsSettlement: serverConfigs.has(source.environmentId),
            target,
            projectThreadKeys: sourceProjectThreadKeys,
            pinnedOrder: pinnedKeys,
            pinnedKeysById,
            reorderableKeys: draggableThreadKeys,
            activeOrder: activeKeys,
            activeKeysById,
            activeReorderableKeys: activeReorderableThreadKeys,
            activeTimeOrdered: workingShelfEnabled,
          }).kind !== "none"
        );
      },
      {
        items: sidebarListItems,
        activationY: dragActivationY ?? null,
      },
    );
  })();
  const handleThreadDragEnd = (event: DragEndEvent) => {
    const activeKey = String(event.active.id);
    const activeSection = sectionByThreadKey.get(activeKey);
    const target =
      event.over === null
        ? null
        : resolveSidebarDropTarget(sidebarListItems, activeKey, String(event.over.id));
    const activeThread = threadByKey.get(activeKey);
    if (activeSection === undefined || target === null || activeThread === undefined) return;
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const plan = planSidebarThreadDrop({
      activeKey,
      activeSection,
      // A strip shows as pinned while any tab is, not only the selected one.
      activePinned: activeSection === "pinned" || activeThread.pinnedAt != null,
      activeSettled: activeThread.settledOverride === "settled",
      supportsSettlement: serverConfigs.has(activeThread.environmentId),
      target,
      projectThreadKeys: projectThreadKeysFor(
        projectKeyByThreadProject.get(`${activeThread.environmentId}:${activeThread.projectId}`),
      ),
      pinnedOrder: pinnedKeys,
      pinnedKeysById,
      reorderableKeys: draggableThreadKeys,
      activeOrder: activeKeys,
      activeKeysById,
      activeReorderableKeys: activeReorderableThreadKeys,
      activeTimeOrdered: workingShelfEnabled,
    });
    if (plan.kind === "none") return;
    if (plan.kind === "settle" && settlingThreadKeysRef.current.has(activeKey)) return;
    const assignments =
      plan.kind === "pin"
        ? [
            ...(plan.orderKey === undefined ? [] : [{ id: activeKey, orderKey: plan.orderKey }]),
            ...plan.extraAssignments,
          ]
        : plan.kind === "reorder-pinned" || plan.kind === "move-active"
          ? plan.assignments
          : [];
    if (
      !checkThreadOperations(
        [activeKey, ...assignments.map(({ id }) => id)].flatMap((key) => {
          const thread = threadByKey.get(key);
          return thread ? [thread] : [];
        }),
      )
    )
      return;
    const drop = {
      key: activeKey,
      sourceSection: activeSection,
      section: target.section,
      occurredAt: new Date().toISOString(),
      clearsSnooze:
        plan.kind === "pin" ||
        plan.kind === "settle" ||
        (plan.kind === "move-active" && plan.unsnooze),
      order: plan.kind === "settle" ? null : plan.order,
      keysAtDrop: target.section === "active" ? activeKeysById : pinnedKeysById,
      assignedKeys: new Map(assignments.map(({ id, orderKey }) => [id, orderKey])),
    };
    setOptimisticDrop(drop);
    void (async () => {
      const run = async (
        operation: Promise<AtomCommandResult<unknown, unknown>>,
        title: string,
      ) => {
        const result = await operation;
        if (result._tag === "Success") return true;
        setOptimisticDrop((current) => (current === drop ? null : current));
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      };
      switch (plan.kind) {
        case "settle": {
          settlingThreadKeysRef.current.add(activeKey);
          const navigateAfterSettle = planForwardNavigation(activeKey);
          const settled = await run(settleThread(threadRef), "Failed to settle thread").finally(
            () => settlingThreadKeysRef.current.delete(activeKey),
          );
          if (
            settled &&
            shouldNavigateAfterThreadPark({
              threadKey: activeKey,
              currentThreadKey: readRouteThreadKey(router),
              action: "settle",
              now: new Date().toISOString(),
              thread: readThreadShell(threadRef),
            })
          )
            navigateAfterSettle?.();
          else releaseParkingRouteThread(activeKey);
          return;
        }
        case "move-active":
          if (plan.unpin && !(await run(unpinThread(threadRef), "Failed to unpin thread"))) return;
          if (
            plan.unsettle &&
            !(await run(unsettleThread(threadRef), "Failed to un-settle thread"))
          )
            return;
          if (plan.unsnooze && !(await run(unsnoozeThread(threadRef), "Failed to wake thread")))
            return;
          break;
        case "pin":
          if (
            !(await run(
              pinThread(threadRef, plan.orderKey === undefined ? {} : { orderKey: plan.orderKey }),
              "Failed to pin thread",
            ))
          )
            return;
          break;
        case "reorder-pinned":
          break;
      }
      const keyWrites = plan.kind === "pin" ? plan.extraAssignments : plan.assignments;
      for (const assignment of keyWrites) {
        const thread = threadByKey.get(assignment.id);
        if (thread === undefined) continue;
        if (
          !(await run(
            (plan.kind === "move-active" ? reorderActiveThread : reorderPinnedThread)(
              scopeThreadRef(thread.environmentId, thread.id),
              assignment.orderKey,
            ),
            plan.kind === "move-active"
              ? "Failed to reorder active threads"
              : "Failed to reorder pinned threads",
          ))
        )
          return;
      }
    })();
  };
  const performSnooze = async (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    const threadKey = scopedThreadKey(threadRef);
    if (snoozingThreadKeysRef.current.has(threadKey)) {
      return { status: "skipped" } as const;
    }
    snoozingThreadKeysRef.current.add(threadKey);
    const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
    const result = await snoozeThread(threadRef, preset.snoozedUntil);
    snoozingThreadKeysRef.current.delete(threadKey);
    if (result._tag === "Failure") {
      releaseParkingRouteThread(threadKey);
      return isAtomCommandInterrupted(result)
        ? ({ status: "interrupted" } as const)
        : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
    }
    if (
      shouldNavigateAfterThreadPark({
        threadKey,
        currentThreadKey: readRouteThreadKey(router),
        action: "snooze",
        // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
        now: new Date().toISOString(),
        thread: readThreadShell(threadRef),
      })
    ) {
      navigateAfterSnooze?.();
    } else {
      releaseParkingRouteThread(threadKey);
    }
    return { status: "success" } as const;
  };
  const attemptSnooze = (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const outcome = await performSnooze(threadRef, preset, opts);
      if (outcome.status === "failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to snooze thread",
            description:
              outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
          }),
        );
        return;
      }
    })();
  };

  const handleMultiSelectContextMenu = useStableCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) =>
        threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
      const selectionNow = new Date();
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const settlingThreads = selectedThreads.filter(
        (thread) => thread.settledOverride !== "settled",
      );
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          serverConfigs.has(thread.environmentId) &&
          canSnooze(thread, { now: selectionNow.toISOString() }),
      );
      const titleRegenerationThreads = selectedThreads.filter((thread) =>
        serverConfigs.has(thread.environmentId),
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      const pinnedSelectedThreads = selectedThreads.filter(
        (thread) => serverConfigs.has(thread.environmentId) && thread.pinnedAt != null,
      );
      const unpinMenuItem = buildBulkUnpinContextMenuItem({
        pinnedCount: pinnedSelectedThreads.length,
      });
      // Presets sync across environments, so the first selected thread's stand for all.
      // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
      const menuOpenedAt = new Date();
      const snoozePresets = resolveSnoozePresets(
        menuOpenedAt,
        timestampFormat,
        selectedThreads[0]!.environmentId,
      );
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(unpinMenuItem
              ? [{ ...unpinMenuItem, disabled: !canOperateThreads(pinnedSelectedThreads) }]
              : []),
            {
              id: "settle",
              label: `Settle (${count})`,
              disabled: settlingThreads.length === 0 || !canOperateThreads(settlingThreads),
            },
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    disabled: !canOperateThreads(selectedThreads),
                    children: [
                      ...snoozePresets.map((preset) => ({
                        id: `snooze:${preset.id}`,
                        label: `${preset.label} (${preset.whenLabel})`,
                        disabled: !canOperateThreads(selectedThreads),
                      })),
                      {
                        id: "snooze:custom",
                        label: "Custom…",
                        separatorBefore: snoozePresets.length > 0,
                        disabled: !canOperateThreads(selectedThreads),
                      },
                    ],
                  },
                ]
              : []),
            ...(titleRegenerationMenuItem
              ? [
                  {
                    ...titleRegenerationMenuItem,
                    disabled:
                      titleRegenerationMenuItem.disabled ||
                      !canOperateThreads(regeneratableTitleThreads),
                  },
                ]
              : []),
            { id: "mark-unread", label: `Mark unread (${count})` },
            {
              id: "delete",
              label: `Delete (${count})`,
              destructive: true,
              disabled: !canOperateThreads(selectedThreads),
            },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const actionTargets =
        clicked.value === "unpin"
          ? pinnedSelectedThreads
          : clicked.value === "regenerate-title"
            ? regeneratableTitleThreads
            : clicked.value === "settle"
              ? settlingThreads.flatMap((thread) => {
                  const current = threadByKeyRef.current.get(
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                  );
                  return current && current.settledOverride !== "settled" ? [current] : [];
                })
              : selectedThreads;
      if (clicked.value === "settle" && actionTargets.length === 0) return;
      if (clicked.value !== "mark-unread" && !checkThreadOperations(actionTargets)) return;
      if (clicked.value?.startsWith("snooze:")) {
        const preset =
          clicked.value === "snooze:custom"
            ? await requestCustomSnooze()
            : pickSnoozePreset(
                snoozePresets,
                clicked.value.slice("snooze:".length),
                timestampFormat,
                selectedThreads[0]!.environmentId,
              );
        if (preset) {
          const coSnoozingKeys = new Set(threadKeys);
          clearSelection();
          const outcomes = await Promise.all(
            selectedThreads.map(async (thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
              return { outcome, threadRef };
            }),
          );
          const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
            outcome.status === "success" ? [threadRef] : [],
          );
          const failures = outcomes.flatMap(({ outcome }) =>
            outcome.status === "failure" ? [outcome.error] : [],
          );

          if (failures.length > 0) {
            const firstError = failures[0];
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  snoozedThreadRefs.length > 0
                    ? `Failed to snooze ${failures.length} thread${failures.length === 1 ? "" : "s"}`
                    : "Failed to snooze threads",
                description:
                  firstError instanceof Error ? firstError.message : "An error occurred.",
              }),
            );
          }
        }
        return;
      }
      if (clicked.value === "unpin") {
        for (const thread of pinnedSelectedThreads) {
          attemptUnpin(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        settleThreads(
          actionTargets.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        );
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (thread) markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      if (
        !checkThreadOperations(
          threadKeys.flatMap((threadKey) => {
            const thread = threadByKeyRef.current.get(threadKey);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: threadKeys.map((threadKey) => ({ threadKey })),
        delete: async ({ threadKey }, deletedThreadKeys) => {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return null;
          return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            deletedThreadKeys,
          });
        },
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
  );

  const handleDraftContextMenu = useStableCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const projectGroup = projectGroupsRef.current.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === session.environmentId && ref.projectId === session.projectId,
          ),
        );
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              hasPath: Boolean(workspacePath),
              hasBranch: Boolean(session.branch),
              hasProject: projectGroup != null,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "project-settings":
            if (projectGroup)
              openProjectSettings(projectGroup, {
                environmentId: session.environmentId,
                projectId: session.projectId,
              });
            return;
          case "copy-path":
            if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          case "copy-branch":
            if (session.branch) copyBranchToClipboard(session.branch, { branch: session.branch });
            return;
          case "discard": {
            // The menu may outlive draft promotion; discarding then would strand the send.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
  );

  // Grouped projects copy one checkout per member, labelled by environment.
  const handleProjectContextMenu = (
    projectGroup: SidebarProjectSnapshot,
    position: { x: number; y: number },
    options: {
      expansionKey: string;
      expanded: boolean;
      canCreate: boolean;
      onNewThread: () => void;
    },
  ) => {
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const members = projectGroup.memberProjects;
      const copyPathItems = members.map((member, index) => ({
        id: `copy-path:${index}`,
        label: member.environmentLabel
          ? `${member.environmentLabel}: ${member.workspaceRoot}`
          : member.workspaceRoot,
        icon: "folder",
      }));
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            {
              id: "new-thread",
              label: "New thread",
              icon: "message-square-plus",
              disabled: !options.canCreate,
            },
            {
              id: "toggle-expanded",
              label: options.expanded ? "Collapse" : "Expand",
              icon: "chevron-right",
            },
            copyPathItems.length === 1
              ? { ...copyPathItems[0]!, label: "Copy Path" }
              : {
                  id: "copy-path",
                  label: "Copy Path",
                  icon: "folder",
                  disabled: copyPathItems.length === 0,
                  children: copyPathItems,
                },
            {
              id: "project-settings",
              label: "Project settings",
              icon: "settings",
              separatorBefore: true,
            },
            { id: "hide", label: "Hide from sidebar", icon: "eye-off" },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || !clicked.value) return;
      const action = clicked.value;
      if (action === "new-thread") return options.onNewThread();
      if (action === "toggle-expanded") {
        return setProjectExpanded(options.expansionKey, !options.expanded);
      }
      if (action === "project-settings") return openProjectSettings(projectGroup);
      if (action === "hide") return setProjectHidden(projectGroup.projectKey, true);
      if (action.startsWith("copy-path:")) {
        const member = members[Number(action.slice("copy-path:".length))];
        if (member) copyPathToClipboard(member.workspaceRoot, { path: member.workspaceRoot });
      }
    })();
  };

  const handleHiddenProjectsMenu = (position: { x: number; y: number }) => {
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...hiddenProjectGroups.map((group) => ({
              id: `show:${group.projectKey}`,
              label: `Show ${group.displayName}`,
            })),
            { id: "show-all", label: "Show all", separatorBefore: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || !clicked.value) return;
      const keys =
        clicked.value === "show-all"
          ? hiddenProjectGroups.map((group) => group.projectKey)
          : [clicked.value.slice("show:".length)];
      for (const key of keys) setProjectHidden(key, false);
    })();
  };

  const handleThreadContextMenu = useStableCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ??
          null;
        const configLoaded = serverConfigs.has(thread.environmentId);
        const isRegeneratingTitle = thread.titleRegeneration != null;
        // Hidden tabs are not on a shelf, so read their own lifecycle state.
        const isSettled = configLoaded && thread.settledOverride === "settled";
        const isSnoozed =
          configLoaded && effectiveSnoozed(thread, { now: new Date().toISOString() });
        const isPinned = thread.pinnedAt != null;
        const snoozePresets = resolveSnoozePresets(
          new Date(),
          timestampFormat,
          thread.environmentId,
        );
        const threadProjectGroup =
          projectGroupsRef.current.find((project) =>
            project.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === thread.environmentId &&
                projectRef.projectId === thread.projectId,
            ),
          ) ?? null;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildThreadActionMenuItems({
              canOperate: readEnvironmentScope(
                threadRef.environmentId,
                AuthOrchestrationOperateScope,
              ),
              branch: thread.branch ?? null,
              projectFilter: threadProjectGroup
                ? {
                    label: threadProjectGroup.displayName,
                    isActive: projectScopeKeys.includes(threadProjectGroup.projectKey),
                  }
                : null,
              isPinned,
              isSettled,
              isSnoozed,
              canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
              isRegeneratingTitle,
              isRunning: !threadRuntimeCanArchive(thread.runtime),
              canShareWithGuest: appAtomRegistry.get(
                canShareWithGuestAtom(threadRef.environmentId),
              ),
              supports: {
                settlement: configLoaded,
                snooze: configLoaded,
                pinning: configLoaded,
                titleRegeneration: configLoaded,
              },
              snoozePresets,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (threadActionRequiresOperate(clicked.value) && !checkThreadOperations([thread])) return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset =
            clicked.value === "snooze:custom"
              ? await requestCustomSnooze()
              : pickSnoozePreset(
                  snoozePresets,
                  clicked.value.slice("snooze:".length),
                  timestampFormat,
                  thread.environmentId,
                );
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        switch (clicked.value) {
          case "filter-by-project":
            if (threadProjectGroup) {
              setProjectScopeKeys(
                projectScopeKeys.includes(threadProjectGroup.projectKey)
                  ? []
                  : [threadProjectGroup.projectKey],
              );
            }
            return;
          case "project-settings":
            if (threadProjectGroup)
              openProjectSettings(threadProjectGroup, {
                environmentId: threadRef.environmentId,
                projectId: thread.projectId,
              });
            return;
          case "new-thread-on-branch": {
            const result = await settlePromise(() =>
              handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "pin":
            attemptPin(threadRef);
            return;
          case "unpin":
            attemptUnpin(threadRef);
            return;
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "share-guest":
            openGuestShareDialog(threadRef);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "copy-path":
            if (!threadWorkspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread":
            void copyThreadReference(threadChipCopyTarget(threadRef, thread.title));
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: didArchive
                    ? "Thread archived, but navigation failed"
                    : "Failed to archive thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
  );

  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown for thread navigation shortcuts using the current thread list
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeRowThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeRowThreadKey,
    routeTerminalOpen,
    threadByKey,
  ]);

  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  const showJumpHints = useThreadJumpHintsVisible(shouldShowJumpHintsNow);

  const handleNewThreadClick = (event?: ReactMouseEvent) => {
    if (
      boringSidebarEnabled ||
      shouldCreateNewThreadInCurrentProject(event?.shiftKey ?? false, projectGroups.length)
    ) {
      if (isMobile) setOpenMobile(false);
      void startNewThreadFromContext({
        activeDraftThread: newThreadContext.activeDraftThread,
        activeThread: newThreadContext.activeThread ?? undefined,
        defaultProjectRef: newThreadContext.defaultProjectRef,
        handleNewThread,
      });
      return;
    }
    if (isMobile) setOpenMobile(false);
    openCommandPalette({ open: "new-thread-in" });
  };

  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroups.length <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  return (
    <>
      <ThreadContextDragGhost />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <SidebarThreadHeader
              searchFieldRef={headerSearchRef}
              hasProjects={projectGroups.length > 0}
              projectScope={
                <Combobox
                  items={projectScopeItems}
                  filteredItems={filteredProjectScopeItems}
                  autoHighlight
                  itemToStringLabel={(item) => item.label}
                  isItemEqualToValue={(a, b) => a.value === b.value}
                  open={projectScopeMenuState.open}
                  onOpenChange={(open, eventDetails) => {
                    if (eventDetails.isCanceled) return;
                    if (open) suppressNextScopeChangeRef.current = false;
                    dispatchProjectScopeMenu({ type: "open-changed", open });
                  }}
                  onItemHighlighted={(item) => {
                    highlightedProjectScopeKeyRef.current = item?.value ?? null;
                  }}
                  value={selectedProjectScopeItem}
                  onValueChange={(item, eventDetails) => {
                    if (suppressNextScopeChangeRef.current) {
                      suppressNextScopeChangeRef.current = false;
                      return;
                    }
                    if (!item) return;
                    if (item.value === "all") {
                      setProjectScopeKeys([]);
                    } else if (
                      eventDetails.event instanceof MouseEvent &&
                      eventDetails.event.shiftKey
                    ) {
                      // Canceling skips Base UI's commit, which would freeze the search query, and its close.
                      eventDetails.cancel();
                      toggleProjectScopeKey(item.value);
                    } else {
                      setProjectScopeKeys([item.value]);
                    }
                  }}
                >
                  <ComboboxTrigger
                    render={
                      <SidebarHeaderIconButton
                        label={
                          scopedProjectGroups.length > 0
                            ? `Filter threads by project: ${scopedProjectGroups.map((project) => project.displayName).join(", ")}`
                            : "Filter threads by project"
                        }
                      />
                    }
                  >
                    {scopedProjectGroups.length > 1 ? (
                      <span className="flex shrink-0 -space-x-1.5">
                        {scopedProjectGroups.slice(0, 2).map((project) => (
                          <ProjectFavicon
                            key={project.projectKey}
                            project={project}
                            className="size-3.5"
                          />
                        ))}
                      </span>
                    ) : scopedProjectGroups[0] ? (
                      <span className="flex shrink-0">
                        <ProjectFavicon project={scopedProjectGroups[0]} className="size-4" />
                      </span>
                    ) : (
                      <ListFilterIcon className="size-4" />
                    )}
                  </ComboboxTrigger>
                  <ComboboxPopup
                    align="start"
                    anchor={headerSearchRef}
                    className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
                  >
                    <ComboboxSearchInput
                      aria-label="Search projects"
                      placeholder="Search projects..."
                      value={projectScopeMenuState.query}
                      onKeyDown={(event) => {
                        if (
                          event.defaultPrevented ||
                          event.nativeEvent.isComposing ||
                          event.keyCode === 229 ||
                          event.ctrlKey ||
                          event.altKey ||
                          event.metaKey
                        ) {
                          return;
                        }
                        const scopeKey = highlightedProjectScopeKeyRef.current;
                        const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
                        if (event.shiftKey && event.key === "Enter") {
                          if (!project) return;
                          event.preventDefault();
                          toggleProjectScopeKey(project.projectKey);
                          return;
                        }
                        if (
                          event.key !== "ContextMenu" &&
                          !(event.shiftKey && event.key === "F10")
                        ) {
                          return;
                        }
                        if (project) handleProjectSettings(event, project);
                      }}
                      onChange={(event) =>
                        dispatchProjectScopeMenu({
                          type: "query-changed",
                          query: event.target.value,
                        })
                      }
                    />
                    <ComboboxEmpty>No matching projects.</ComboboxEmpty>
                    <ComboboxList aria-multiselectable>
                      {(item: (typeof projectScopeItems)[number]) => {
                        const project = projectGroupByScopeKey.get(item.value) ?? null;
                        const isSelected = project
                          ? projectScopeKeys.includes(item.value)
                          : projectScopeKeys.length === 0;
                        return (
                          <ComboboxItem
                            key={item.value}
                            hideIndicator
                            value={item}
                            aria-selected={isSelected}
                            // The icon badge marks selection; Base UI's single value would shade one row.
                            data-selected={undefined}
                            onContextMenu={(event) => {
                              if (project) handleProjectSettings(event, project);
                            }}
                          >
                            <ProjectScopeRowIcon isSelected={isSelected}>
                              {project ? (
                                <ProjectFavicon project={project} className="size-4 shrink-0" />
                              ) : (
                                <FolderIcon className="size-4 shrink-0" />
                              )}
                            </ProjectScopeRowIcon>
                            <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                            {project && showProjectEnvironments ? (
                              <ProjectEnvironmentBadge
                                group={project}
                                primaryEnvironmentId={primaryEnvironmentId}
                                machineByEnvironmentId={environmentMachineById}
                              />
                            ) : null}
                            {project ? (
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                tabIndex={-1}
                                aria-hidden="true"
                                title={`Project settings for ${project.displayName}`}
                                className="ml-auto"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  void handleProjectSettings(event, project);
                                }}
                              >
                                <SettingsIcon className="size-3.5" />
                              </Button>
                            ) : null}
                          </ComboboxItem>
                        );
                      }}
                    </ComboboxList>
                  </ComboboxPopup>
                </Combobox>
              }
              onNewProject={openAddProjectCommandPalette}
              onNewThread={handleNewThreadClick}
              newThreadDisabled={projects.length === 0}
              newThreadShortcutLabel={newThreadShortcutLabel}
              newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
              showNewThreadInProjectHint={!boringSidebarEnabled && projectGroups.length > 1}
              searchInputRef={threadSearchInputRef}
              searchQuery={threadSearchQuery}
              onSearchQueryChange={(value) => {
                setThreadSearchQuery(value);
                setSearchHighlightKey(null);
              }}
              onSearchKeyDown={handleThreadSearchKeyDown}
              isSearching={isSearchingThreads}
              searchResultCount={threadSearchResults.length}
              activeSearchResultIndex={activeSearchResultIndex}
              onClearSearch={clearThreadSearch}
            />
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <ul
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                  className="flex flex-col gap-px"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return (
                      <SidebarSearchResultRow
                        isSettled={settledThreadKeys.has(threadKey)}
                        key={threadKey}
                        thread={thread}
                        project={
                          projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectDisplayName={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        environmentMachine={
                          environmentMachineById.get(thread.environmentId) ?? "server"
                        }
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeRowThreadKey === threadKey}
                        resultId={threadSearchResultId(index)}
                        searchMatch={
                          threadSearchMatchByKey.get(
                            threadSearchMatchKey({
                              environmentId: thread.environmentId,
                              threadId: thread.id,
                            }),
                          ) ?? null
                        }
                        searchQuery={threadSearchQuery}
                        searchMatchQuery={threadSearch.query}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                        onFileDropThreads={handleThreadFileDrop}
                      />
                    );
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                {threadSearch.isPending ? "Searching thread messages…" : "No threads found"}
              </p>
            )
          ) : null}
          {!isSearchingThreads ? (
            <TooltipProvider
              key="sidebar-thread-tooltips-150"
              delay={150}
              closeDelay={0}
              timeout={400}
            >
              <DndContext
                sensors={dndSensors}
                autoScroll={!isContextDrag}
                collisionDetection={dndCollisionDetection}
                modifiers={dndModifiers}
                onDragStart={handleThreadDragStart}
                onDragOver={handleThreadDragOver}
                onDragEnd={handleThreadDragEnd}
              >
                <SortableContext items={sortableIds} strategy={sidebarSortingStrategy}>
                  <ul
                    {...SIDEBAR_TREE_PROPS}
                    ref={attachTreeRef}
                    className={cn(
                      "sidebar-thread-list relative flex flex-col gap-px",
                      sidebarListItems.length > 0 && "flex-1",
                      // A sweep or drag owns the pointer: rows it passes over
                      // must not show hover states or tooltips.
                      (actionSweep !== null || dragState !== null) && "**:pointer-events-none",
                    )}
                  >
                    {(() => {
                      const from = isContextDrag ? null : (dragState?.activeSection ?? null);
                      const dragProjectKey =
                        dragState === null
                          ? undefined
                          : sidebarListItems.find(
                              (item) => item.kind === "thread" && item.key === dragState.activeKey,
                            )?.projectKey;
                      // A drag dims every region it cannot drop into: other
                      // projects and other shelves. Pins accept every project.
                      const dimmed = (section: SidebarSection, projectKey?: string) =>
                        from !== null &&
                        section !== "pinned" &&
                        (projectKey !== dragProjectKey ||
                          section !== (from === "pinned" ? "active" : from));
                      const tabSessionPrimaryAction = (
                        session: NonNullable<ReturnType<typeof sessionByThreadKey.get>>,
                      ) =>
                        // The whole session moves, so its shelf, not the
                        // selected tab, picks the action.
                        session.section === "snoozed"
                          ? { kind: "unsnooze" as const, onSelect: attemptUnsnooze }
                          : session.section === "settled"
                            ? { kind: "unsettle" as const, onSelect: attemptUnsettle }
                            : serverConfigs.has(session.thread.environmentId)
                              ? { kind: "settle" as const, onSelect: attemptSettle }
                              : null;
                      const threadRowProps = (
                        thread: EnvironmentThreadShell,
                        section: SidebarSection,
                        // The tree row of the project folder this row sits in.
                        folderRow?: string,
                      ) => {
                        const threadKey = scopedThreadKey(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        const projectKey = `${thread.environmentId}:${thread.projectId}` as const;
                        return {
                          thread,
                          variant: folderRow
                            ? folderRowsMultiline
                              ? ("folder-multiline" as const)
                              : ("folder" as const)
                            : ("slim" as const),
                          navigationParent:
                            folderRow ??
                            (section === "working" || section === "snoozed" || section === "settled"
                              ? `shelf:${section}`
                              : undefined),
                          variantAction:
                            section === "snoozed"
                              ? ("unsnooze" as const)
                              : section === "settled"
                                ? ("unsettle" as const)
                                : ("settle" as const),
                          settlementSupported: serverConfigs.has(thread.environmentId),
                          snoozeSupported: serverConfigs.has(thread.environmentId),
                          pinningSupported: serverConfigs.has(thread.environmentId),
                          isPinned: thread.pinnedAt != null,
                          showProjectIcon: section === "pinned",
                          dimmed: dimmed(section, projectKeyByThreadProject.get(projectKey)),
                          dropVerb:
                            dragState?.activeKey === threadKey
                              ? resolveSidebarDropVerb(dragState.activeSection, dragTargetSection)
                              : null,
                          dragOverPinned:
                            dragState?.activeKey === threadKey && dragTargetSection === "pinned",
                          sweepAction: actionSweep?.keys.has(threadKey) ? actionSweep.action : null,
                          snoozeWakeLabelText:
                            section === "snoozed" && thread.snoozedUntil != null
                              ? snoozeWakeLabel(thread.snoozedUntil, {
                                  now: new Date().toISOString(),
                                })
                              : null,
                          wokeAt: threadWokeAt(thread, { now: snoozeNow }),
                          isActive: routeRowThreadKey === threadKey,
                          revealRef: routeRowThreadKey === threadKey ? revealActiveRow : undefined,
                          isRouteThread: routeThreadKey === threadKey,
                          activeThreadKey: routeThreadKey,
                          openPullRequestsInRightPanel: routeThreadRef !== null,
                          currentEnvironmentId: primaryEnvironmentId,
                          jumpLabel: showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null,
                          environmentLabel: environmentLabelById.get(thread.environmentId) ?? null,
                          environmentMachine:
                            environmentMachineById.get(thread.environmentId) ?? "server",
                          scratchMachineLabel: scratchMachineLabelFor(thread),
                          project: projectByKey.get(projectKey) ?? null,
                          projectDisplayName: projectDisplayNameByKey.get(projectKey) ?? null,
                          providerEntryByInstanceId:
                            providerEntriesByEnvironment.get(thread.environmentId) ??
                            EMPTY_PROVIDER_ENTRIES,
                          timestampFormat,
                          onThreadClick: handleThreadClick,
                          onThreadActivate: navigateToThread,
                          onStartRename: startThreadRename,
                          onRenameTitleChange: setRenamingTitle,
                          onCommitRename: commitThreadRename,
                          onCancelRename: cancelThreadRename,
                          isRenaming: renamingThreadKey === threadKey,
                          renamingTitle: renamingThreadKey === threadKey ? renamingTitle : "",
                          onContextMenu: handleThreadContextMenu,
                          onSettle: attemptSettle,
                          onActionSweepStart: startActionSweep,
                          onUnsettle: attemptUnsettle,
                          onSnooze: attemptSnooze,
                          onUnsnooze: attemptUnsnooze,
                          onUnpin: attemptUnpin,
                          onAcknowledgeWoke: acknowledgeWoke,
                          onFileDropThreads: handleThreadFileDrop,
                        };
                      };
                      const tabSessionRowProps = (
                        session: NonNullable<ReturnType<typeof sessionByThreadKey.get>>,
                        section: SidebarSection,
                      ) => {
                        const thread = session.thread;
                        const threadKey = threadShellKey(thread);
                        const projectKey = `${thread.environmentId}:${thread.projectId}` as const;
                        return {
                          session,
                          dimmed: dimmed(section, projectKeyByThreadProject.get(projectKey)),
                          projectIcon:
                            section === "pinned" ? (projectByKey.get(projectKey) ?? null) : null,
                          activeThreadKey: routeThreadKey,
                          isActive: routeRowThreadKey === threadKey,
                          jumpLabel: showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null,
                          onNavigate: navigateToThread,
                          onContextMenu: handleThreadContextMenu,
                          primaryAction: tabSessionPrimaryAction(session),
                        };
                      };
                      const renderThreadRow = (
                        thread: EnvironmentThreadShell,
                        section: SidebarSection,
                        folderRow?: string,
                      ) => {
                        const threadKey = threadShellKey(thread);
                        const sortableDisabled =
                          projectFolders !== null ||
                          renamingThreadKey === threadKey ||
                          !draggableThreadKeys.has(threadKey) ||
                          optimisticDrop !== null;
                        // A workspace with several chat tabs is one row.
                        const session = sessionByThreadKey.get(threadKey);
                        if (session && session.chats.length > 1) {
                          return (
                            <SortableTabSessionRow
                              key={session.key}
                              sortableId={threadKey}
                              sortableDisabled={sortableDisabled}
                              contextDrag={isContextDrag}
                              {...tabSessionRowProps(session, section)}
                            />
                          );
                        }
                        return (
                          <SortableThreadRow
                            key={threadKey}
                            sortableId={threadKey}
                            sortableDisabled={sortableDisabled}
                            contextDrag={isContextDrag}
                            {...threadRowProps(thread, section, folderRow)}
                          />
                        );
                      };
                      // The drop slot previews the dragged row at its
                      // destination with the destination shelf's styling.
                      const renderDragPreview = (
                        thread: EnvironmentThreadShell,
                        section: SidebarSection,
                      ) => {
                        const session = sessionByThreadKey.get(threadShellKey(thread));
                        return session && session.chats.length > 1 ? (
                          <SidebarTabSessionRow
                            {...tabSessionRowProps(session, section)}
                            dragPreview
                          />
                        ) : (
                          <SidebarThreadRow {...threadRowProps(thread, section)} dragPreview />
                        );
                      };
                      const renderProjectSection = (section: SidebarSection) => {
                        if (section === "pinned")
                          return threadsForSection("pinned").map((thread) =>
                            renderThreadRow(thread, "pinned"),
                          );
                        const grouped = projectSections[section]!;
                        return [
                          ...grouped.groups.flatMap((group) => {
                            const targetProject =
                              group.project.memberProjects.find(
                                (project) => project.environmentId === primaryEnvironmentId,
                              ) ?? group.project.memberProjects[0];
                            // Opening a local draft is not a source-server mutation.
                            // Permissions are checked on the destination when it runs.
                            const canCreate = targetProject !== undefined;
                            const onNewThread = () => {
                              if (!targetProject) return;
                              if (isMobile) setOpenMobile(false);
                              void handleNewThread(
                                scopeProjectRef(targetProject.environmentId, targetProject.id),
                              );
                            };
                            const showReturnTarget =
                              section === "active" &&
                              dragProjectKey === group.project.projectKey &&
                              group.expanded &&
                              group.draftCount === 0 &&
                              ((from === "pinned" && group.visibleThreads.length === 0) ||
                                (from === "active" &&
                                  dragTargetSection === "pinned" &&
                                  group.visibleThreads.length === 1 &&
                                  threadShellKey(group.visibleThreads[0]!) ===
                                    dragState?.activeKey));
                            return [
                              <SidebarProjectHeader
                                key={`${section}:${group.project.projectKey}`}
                                project={group.project}
                                sortableId={sidebarProjectHeaderId(
                                  section,
                                  group.project.projectKey,
                                )}
                                visible={section === "active" || group.threads.length > 0}
                                expanded={group.expanded}
                                count={group.threads.length + group.draftCount}
                                canCreate={canCreate}
                                dimmed={dimmed(section, group.project.projectKey)}
                                onToggle={() =>
                                  setProjectExpanded(group.expansionKey, !group.expanded)
                                }
                                onContextMenu={(position) =>
                                  handleProjectContextMenu(group.project, position, {
                                    expansionKey: group.expansionKey,
                                    expanded: group.expanded,
                                    canCreate,
                                    onNewThread,
                                  })
                                }
                                onNewThread={onNewThread}
                                onProjectDrop={(draggedKey, position) =>
                                  handleProjectDrop(draggedKey, group.project.projectKey, position)
                                }
                              />,
                              ...(section === "active"
                                ? [
                                    <SortableSidebarMarker
                                      key={`return-target:${section}:${group.project.projectKey}`}
                                      marker="active-placeholder"
                                      projectKey={group.project.projectKey}
                                      dimmed={dimmed(section, group.project.projectKey)}
                                      className={
                                        showReturnTarget
                                          ? "flex h-9 items-center justify-center text-xs text-primary"
                                          : "-mb-px h-0"
                                      }
                                    >
                                      {showReturnTarget
                                        ? from === "pinned"
                                          ? "Drop here to unpin"
                                          : "Drop here to return"
                                        : null}
                                    </SortableSidebarMarker>,
                                    <SortableSidebarMarker
                                      key={`draft-block:${group.project.projectKey}`}
                                      marker="draft-block"
                                      dimmed={dimmed(section, group.project.projectKey)}
                                      projectKey={group.project.projectKey}
                                      className="-mb-px"
                                    >
                                      <ul role="presentation" className="flex flex-col gap-px">
                                        <SidebarDraftBlock
                                          key={`drafts:${group.project.projectKey}`}
                                          projectDisplayNameByKey={projectDisplayNameByKey}
                                          scopedProjectKeys={group.draftProjectKeys}
                                          expanded={group.expanded}
                                          routeDraftId={routeDraftIdForRows}
                                          onNavigateToDraft={navigateToDraft}
                                          onDraftContextMenu={handleDraftContextMenu}
                                        />
                                      </ul>
                                    </SortableSidebarMarker>,
                                  ]
                                : []),
                              ...group.visibleThreads.map((thread) =>
                                renderThreadRow(thread, section),
                              ),
                            ];
                          }),
                          // Drafts whose project is not loaded have no group.
                          ...(section === "active"
                            ? [
                                <SidebarDraftBlock
                                  key="drafts:ungrouped"
                                  projectDisplayNameByKey={projectDisplayNameByKey}
                                  scopedProjectKeys={scopedProjectKeys}
                                  excludedProjectKeys={knownProjectKeys}
                                  routeDraftId={routeDraftIdForRows}
                                  onNavigateToDraft={navigateToDraft}
                                  onDraftContextMenu={handleDraftContextMenu}
                                />,
                              ]
                            : []),
                          ...grouped.ungrouped.map((thread) =>
                            renderThreadRow(
                              thread,
                              section === "active" ? mainThreadSection(thread) : section,
                            ),
                          ),
                        ];
                      };
                      const items: ReactNode[] = [];
                      for (const item of sidebarListItems) {
                        // Threads and project markers render with their section.
                        if (item.kind !== "marker" || item.projectKey !== undefined) continue;
                        if (projectFolders !== null && item.marker === "active-placeholder") {
                          for (const folder of projectFolders) {
                            items.push(
                              <SidebarProjectFolderHeader
                                key={`project-folder:${folder.group.projectKey}`}
                                group={folder.group}
                                collapsed={folder.collapsed}
                                hiddenThreads={folder.hiddenThreads}
                                onToggle={toggleProjectFolder}
                                onNewThread={startThreadInProjectFolder}
                                onContextMenu={handleProjectFolderContextMenu}
                              />,
                            );
                            for (const thread of folder.threads) {
                              items.push(
                                renderThreadRow(
                                  thread,
                                  "active",
                                  sidebarFolderRowId(folder.group.projectKey),
                                ),
                              );
                            }
                          }
                          continue;
                        }
                        switch (item.marker) {
                          case "pinned-header":
                            items.push(
                              <SortableSidebarMarker
                                key="pinned-header"
                                marker="pinned-header"
                                data-testid="sidebar-pinned-header"
                                className={
                                  from !== null || pinnedKeys.length > 0
                                    ? "flex h-8 items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground"
                                    : "-mb-px h-0"
                                }
                              >
                                {from !== null || pinnedKeys.length > 0 ? (
                                  <>
                                    <PinIcon className="size-3" />
                                    Pins
                                  </>
                                ) : null}
                              </SortableSidebarMarker>,
                              ...renderProjectSection("pinned"),
                            );
                            break;
                          case "pinned-placeholder":
                            items.push(
                              <SortableSidebarMarker
                                key="pinned-placeholder"
                                marker="pinned-placeholder"
                                data-testid="sidebar-pinned-placeholder"
                                className={
                                  from !== null && pinnedKeys.length === 0
                                    ? "flex h-9 items-center justify-center text-xs text-primary"
                                    : "-mb-px h-0"
                                }
                              >
                                {from !== null && pinnedKeys.length === 0
                                  ? "Drop here to pin"
                                  : null}
                              </SortableSidebarMarker>,
                            );
                            break;
                          case "pinned-divider":
                            items.push(
                              <SortableSidebarMarker
                                key="pinned-divider"
                                marker="pinned-divider"
                                className="-mb-px h-0"
                              />,
                            );
                            break;
                          case "active-placeholder":
                            items.push(
                              <SortableSidebarMarker
                                key="active-placeholder"
                                marker="active-placeholder"
                                className="-mb-px h-0"
                              />,
                            );
                            items.push(...renderProjectSection("active"));
                            break;
                          case "working-header":
                            items.push(
                              <SidebarSectionHeader
                                key="working-shelf-header"
                                marker="working-header"
                                dimmed={from !== null}
                                className="mt-auto"
                                label="Working"
                                count={workingThreads.length}
                                hostsUndoNotice
                                toggle={{
                                  expanded: workingShelfExpanded,
                                  onToggle: toggleWorkingShelf,
                                }}
                              />,
                            );
                            items.push(...renderProjectSection("working"));
                            break;
                          case "snoozed-header":
                            items.push(
                              <SidebarSectionHeader
                                key="snoozed-shelf-header"
                                marker="snoozed-header"
                                dimmed={from !== null && from !== "snoozed"}
                                className={cn(workingThreads.length === 0 && "mt-auto")}
                                label="Snoozed"
                                count={snoozedThreads.length}
                                hostsUndoNotice={workingThreads.length === 0}
                                toggle={{
                                  expanded: snoozedShelfExpanded,
                                  onToggle: toggleSnoozedShelf,
                                }}
                              />,
                            );
                            items.push(...renderProjectSection("snoozed"));
                            break;
                          case "settled-header":
                            items.push(
                              <SidebarSectionHeader
                                key="settled-shelf-header"
                                marker="settled-header"
                                dimmed={from !== null && from !== "settled"}
                                className={cn(
                                  workingThreads.length + snoozedThreads.length === 0 && "mt-auto",
                                )}
                                label="Settled"
                                count={settledCount}
                                hostsUndoNotice={
                                  workingThreads.length + snoozedThreads.length === 0
                                }
                                dragging={from !== null}
                                isDropTarget={dragTargetSection === "settled"}
                                toggle={{
                                  expanded: settledShelfExpanded,
                                  onToggle: toggleSettledShelf,
                                }}
                              />,
                            );
                            break;
                          case "settled-placeholder":
                            items.push(
                              <SidebarSectionPlaceholder
                                key="settled-placeholder"
                                marker="settled-placeholder"
                                label="Settled"
                                showHint={
                                  from === "settled" &&
                                  (renderedSettledThreads.length === 0 ||
                                    (renderedSettledThreads.length === 1 &&
                                      dragTargetSection !== null &&
                                      dragTargetSection !== "settled"))
                                }
                                isDropTarget={dragTargetSection === "settled"}
                              />,
                            );
                            items.push(...renderProjectSection("settled"));
                            break;
                        }
                      }
                      const draggedThread =
                        dragState === null ? undefined : threadByKey.get(dragState.activeKey);
                      if (draggedThread && dragState) {
                        if (!isContextDrag)
                          items.push(
                            <SidebarDragRegions
                              key="drag-regions"
                              items={sidebarListItems}
                              strategy={sidebarSortingStrategy}
                            />,
                          );
                        items.push(
                          <SidebarDropSlot
                            key="drop-slot"
                            items={sidebarListItems}
                            strategy={sidebarSortingStrategy}
                            disabled={isContextDrag}
                          >
                            {renderDragPreview(
                              draggedThread,
                              dragTargetSection ?? dragState.activeSection,
                            )}
                          </SidebarDropSlot>,
                        );
                      }
                      return items;
                    })()}
                    {settledShelfExpanded && hiddenSettledCount > 0 ? (
                      <li className="list-none">
                        <button
                          type="button"
                          role="treeitem"
                          tabIndex={-1}
                          data-sidebar-row="settled:more"
                          data-sidebar-parent="shelf:settled"
                          disabled={olderSettledShelf.loading}
                          onClick={() => {
                            olderSettledShelf.retry();
                            showMoreSettled();
                          }}
                          className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground disabled:cursor-default"
                        >
                          {/* Plus means "add", so revealing more uses a chevron. */}
                          <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
                          {olderSettledShelf.loading
                            ? "Loading"
                            : olderSettledShelf.failed
                              ? "Could not load older threads. Retry"
                              : `Show ${Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more`}
                        </button>
                      </li>
                    ) : null}
                    {hiddenProjectGroups.length > 0 ? (
                      <SidebarHiddenProjectsButton
                        count={hiddenProjectGroups.length}
                        onOpen={handleHiddenProjectsMenu}
                      />
                    ) : null}
                  </ul>
                </SortableContext>
              </DndContext>
            </TooltipProvider>
          ) : null}
          {!isSearchingThreads &&
          !hasProjectFolders &&
          visibleDraftSessionCount === 0 &&
          pinnedThreads.length +
            activeThreads.length +
            workingThreads.length +
            snoozedThreads.length +
            settledCount ===
            0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="-mx-0.5 size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProjectGroups.length > 1 ? (
                "No threads in these projects yet"
              ) : scopedProjectGroups[0] ? (
                `No threads in ${scopedProjectGroups[0].displayName} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter
        showUndoNotice={isSearchingThreads || sidebarListItemsFresh.length === 0}
      />
    </>
  );
}

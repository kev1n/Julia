import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { SquarePenIcon, XIcon } from "lucide-react";
import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useShallow } from "zustand/react/shallow";
import { cn } from "~/lib/utils";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import { selectSidebarDraftSessionKeys } from "../../sidebarDraftSessions";

// Unsent sessions use the same compact geometry as threads. Navigation
// preserves the composer and its settings; the active title stays frozen.
const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  composer: ComposerThreadDraftState;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const { composer, draftId, onContextMenu, onDiscard, onNavigate } = props;
  const promptPreview =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview =
    promptPreview.length > 0
      ? promptPreview
      : attachmentCount > 0
        ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
        : "New thread";
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: "Unsent draft",
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const handleActivate = () => onNavigate(draftId);
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    // Keys targeting the nested discard button belong to the button:
    // preventDefault here would swallow Space's synthesized click and
    // navigate instead of discarding.
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onContextMenu(draftId, { x: rect.left, y: rect.bottom });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onNavigate(draftId);
    }
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(draftId, { x: event.clientX, y: event.clientY });
  };
  const handleDiscard = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onDiscard(draftId);
  };
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={`draft:${draftId}`}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-draft-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <div className="flex h-9 items-center gap-2.5 pr-2.5 pl-7">
          <SquarePenIcon aria-hidden className="size-3 shrink-0 text-icon-muted" />
          {props.project ? (
            <ProjectFavicon project={props.project} className="size-4 shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm">{preview}</span>
          <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
            <span
              aria-hidden
              className="text-xs text-secondary-label group-hover/sidebar-row:opacity-0 group-focus-within/sidebar-row:opacity-0"
            >
              Draft
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Discard draft"
                    onClick={handleDiscard}
                    className="pointer-events-none absolute inset-0 inline-flex cursor-pointer items-center justify-end rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                  >
                    <XIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">Discard draft</TooltipPopup>
            </Tooltip>
          </span>
        </div>
      </div>
    </li>
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

// Each project owns its drafts. Content subscriptions stay here so typing
// does not re-render the sidebar or its project headers.
export const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  scopedProjectKeys: ReadonlySet<string> | null;
  excludedProjectKeys?: ReadonlySet<string>;
  expanded?: boolean;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
  onDraftContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  // Subscribe only to this project's sessions and composer values. Typing
  // in one project must not re-render every project's draft block.
  const draftThreadsByThreadKey = useComposerDraftStore(
    useShallow((store) =>
      Object.fromEntries(
        Object.entries(store.draftThreadsByThreadKey).filter(([, session]) => {
          const key = `${session.environmentId}:${session.projectId}`;
          return (
            (props.scopedProjectKeys === null || props.scopedProjectKeys.has(key)) &&
            !props.excludedProjectKeys?.has(key)
          );
        }),
      ),
    ),
  );
  const draftsByThreadKey = useComposerDraftStore(
    useShallow((store) =>
      Object.fromEntries(
        Object.keys(draftThreadsByThreadKey).flatMap((key) => {
          const composer = store.draftsByThreadKey[key];
          return composer ? [[key, composer] as const] : [];
        }),
      ),
    ),
  );
  // The open draft's row is captured once per route so its title does not
  // follow every keystroke. A fresh session starts as "New thread".
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  const pendingActiveComposer =
    props.routeDraftId === null ? undefined : draftsByThreadKey[props.routeDraftId];
  const pendingActiveSession =
    props.routeDraftId === null ? undefined : draftThreadsByThreadKey[props.routeDraftId];
  if (
    frozenActive.routeDraftId !== props.routeDraftId ||
    (frozenActive.row === null &&
      pendingActiveComposer &&
      pendingActiveSession &&
      pendingActiveSession.promotedTo == null)
  ) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const session = pendingActiveSession;
      const composer = pendingActiveComposer;
      row =
        session && session.promotedTo == null && composer ? { draftId, session, composer } : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = (() => {
    const rows: SidebarDraftRowData[] = [];
    const keys = selectSidebarDraftSessionKeys(
      { draftThreadsByThreadKey, draftsByThreadKey },
      {
        routeDraftId: props.routeDraftId,
        scopedProjectKeys: props.scopedProjectKeys,
        excludedProjectKeys: props.excludedProjectKeys,
        expanded: props.expanded,
      },
    );
    for (const draftKey of keys) {
      const session = draftThreadsByThreadKey[draftKey]!;
      if (draftKey === props.routeDraftId) {
        // Keep the title stable while typing, but read live membership so
        // sending or discarding immediately removes the draft row.
        if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push({ ...frozenActive.row, session });
        }
      } else {
        rows.push({
          draftId: DraftId.make(draftKey),
          session,
          composer: draftsByThreadKey[draftKey]!,
        });
      }
    }
    return rows;
  })();
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            composer={composer}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            onNavigate={props.onNavigateToDraft}
            onDiscard={discardComposerDraft}
            onContextMenu={props.onDraftContextMenu}
          />
        );
      })}
    </>
  );
});

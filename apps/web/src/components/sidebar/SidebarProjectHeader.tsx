import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState, type DragEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { animateSidebarLayoutChanges } from "../Sidebar.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { cn } from "../../lib/utils";

// Native drag data type, so project drags never mix with thread or file drops.
const PROJECT_DRAG_TYPE = "application/x-t3-sidebar-project";

export type SidebarProjectDropPosition = "before" | "after";

export function SidebarProjectHeader(props: {
  project: SidebarProjectSnapshot;
  sortableId: string;
  visible: boolean;
  expanded: boolean;
  count: number;
  canCreate: boolean;
  pinDropHint?: boolean;
  onToggle: () => void;
  onNewThread: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  onProjectDrop: (draggedProjectKey: string, position: SidebarProjectDropPosition) => void;
}) {
  const { setNodeRef, transform, transition, isSorting } = useSortable({
    id: props.sortableId,
    disabled: { draggable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
    transition: { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  });
  const visible =
    transform?.scaleY === 0 ? false : props.visible || (isSorting && transform !== null);
  const [dropPosition, setDropPosition] = useState<SidebarProjectDropPosition | null>(null);
  const positionFor = (event: DragEvent<HTMLLIElement>): SidebarProjectDropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };
  return (
    <li
      ref={setNodeRef}
      data-sidebar-project={props.sortableId}
      className={cn("relative list-none", props.visible ? "h-12" : "-mb-px h-0")}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: visible ? undefined : "hidden",
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropPosition(positionFor(event));
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropPosition(null);
      }}
      onDrop={(event) => {
        const draggedKey = event.dataTransfer.getData(PROJECT_DRAG_TYPE);
        setDropPosition(null);
        if (!draggedKey) return;
        event.preventDefault();
        if (draggedKey !== props.project.projectKey) {
          props.onProjectDrop(draggedKey, positionFor(event));
        }
      }}
    >
      <div className="absolute inset-x-0 top-2 flex h-10 items-center">
        {dropPosition ? (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-primary",
              dropPosition === "before" ? "-top-1" : "-bottom-1",
            )}
          />
        ) : null}
        <button
          type="button"
          draggable
          aria-expanded={props.expanded}
          aria-label={`${props.project.displayName}, ${props.count} sessions`}
          onClick={props.onToggle}
          onDragStart={(event) => {
            event.dataTransfer.setData(PROJECT_DRAG_TYPE, props.project.projectKey);
            event.dataTransfer.effectAllowed = "move";
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            props.onContextMenu({ x: event.clientX, y: event.clientY });
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            props.onContextMenu({ x: rect.left, y: rect.bottom });
          }}
          className="flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", props.expanded && "rotate-90")}
          />
          <ProjectFavicon project={props.project} className="size-4 shrink-0" />
          <span className="truncate">{props.project.displayName}</span>
          <span
            className={cn(
              "shrink-0 text-xs font-normal tabular-nums",
              props.pinDropHint ? "text-primary" : "text-sidebar-muted-foreground",
            )}
          >
            {props.pinDropHint ? "Pin here" : props.count}
          </span>
        </button>
        <button
          type="button"
          aria-label={`New thread in ${props.project.displayName}`}
          disabled={!props.canCreate}
          onClick={props.onNewThread}
          className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
        >
          <PlusIcon aria-hidden className="size-4" />
        </button>
      </div>
    </li>
  );
}

// Reveals hidden projects again; sits at the end of the list while any are hidden.
export function SidebarHiddenProjectsButton(props: {
  count: number;
  onOpen: (position: { x: number; y: number }) => void;
}) {
  return (
    <li className="mt-2 list-none">
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          props.onOpen({ x: rect.left, y: rect.bottom });
        }}
        className="flex h-8 w-full cursor-pointer items-center rounded-md px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {props.count} hidden {props.count === 1 ? "project" : "projects"}
      </button>
    </li>
  );
}

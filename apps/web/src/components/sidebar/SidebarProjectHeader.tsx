import { ChevronRightIcon, PlusIcon } from "lucide-react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { cn } from "../../lib/utils";

export function SidebarProjectHeader(props: {
  project: SidebarProjectSnapshot;
  expanded: boolean;
  count: number;
  canCreate: boolean;
  onToggle: () => void;
  onNewThread: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <li className="mt-2 flex h-10 list-none items-center">
      <button
        type="button"
        aria-expanded={props.expanded}
        aria-label={`${props.project.displayName}, ${props.count} threads`}
        onClick={props.onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onOpenSettings();
        }}
        className="flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", props.expanded && "rotate-90")}
        />
        <ProjectFavicon project={props.project} className="size-4 shrink-0" />
        <span className="truncate">{props.project.displayName}</span>
        <span className="text-xs font-normal tabular-nums text-sidebar-muted-foreground">
          {props.count}
        </span>
      </button>
      <button
        type="button"
        aria-label={`New thread in ${props.project.displayName}`}
        disabled={!props.canCreate}
        onClick={props.onNewThread}
        className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
      >
        <PlusIcon aria-hidden className="size-4" />
      </button>
    </li>
  );
}

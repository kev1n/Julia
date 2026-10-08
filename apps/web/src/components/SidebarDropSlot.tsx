import { useDndContext } from "@dnd-kit/core";
import type { SortingStrategy } from "@dnd-kit/sortable";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { resolveSidebarDropTarget, sidebarListItemId, type SidebarListItem } from "./Sidebar.logic";

/** The same projection positions both neighbours and the destination outline.
 * Only slot/measurement changes read layout; pointer movement inside a slot does not. */
export function SidebarDropSlot(props: {
  items: readonly SidebarListItem[];
  strategy: SortingStrategy;
  children: ReactNode;
  disabled: boolean;
}) {
  const { active, over, droppableRects, droppableContainers } = useDndContext();
  const activeId = active?.id;
  const overId = over?.id;
  const nodeRef = useRef<HTMLLIElement>(null);
  const { disabled, items, strategy } = props;
  const target =
    activeId === undefined || overId === undefined
      ? null
      : resolveSidebarDropTarget(items, String(activeId), String(overId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the drop slot from dnd-kit's measured rects after layout
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node || disabled || activeId === undefined || overId === undefined) return;
    const parent = droppableContainers.get(activeId)?.node.current?.closest(".sidebar-thread-list");
    if (!parent) return;
    const rects: Parameters<SortingStrategy>[0]["rects"] = [];
    for (const item of items) {
      const rect = droppableRects.get(sidebarListItemId(item));
      if (!rect) return;
      rects.push(rect);
    }
    const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeId);
    const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
    const rect = rects[activeIndex];
    if (!rect) return;
    const transform = strategy({
      rects,
      activeIndex,
      overIndex,
      index: activeIndex,
      activeNodeRect: rect,
    });
    if (!transform || transform.scaleY === 0) {
      node.style.visibility = "hidden";
      return;
    }
    const origin = parent.getBoundingClientRect();
    Object.assign(node.style, {
      left: `${rect.left - origin.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      transform: `translateY(${rect.top + transform.y - origin.top}px)`,
      visibility: "visible",
    });
  }, [activeId, overId, droppableContainers, droppableRects, disabled, items, strategy]);
  if (!target || !active || disabled) return null;
  return (
    <li
      ref={nodeRef}
      aria-hidden
      inert
      data-thread-selection-safe
      data-sidebar-motion-skip
      data-testid="sidebar-drop-slot"
      className="sidebar-drop-slot pointer-events-none absolute z-10 rounded-md outline-1 -outline-offset-1 outline-dashed outline-primary/70"
      style={{ top: 0, visibility: "hidden" }}
    >
      <ul role="presentation">{props.children}</ul>
    </li>
  );
}

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

/** Quiet region outlines explain the two destinations; the stronger row
 * outline still shows the exact insertion slot. Both use sortable geometry. */
export function SidebarDragRegions(props: {
  items: readonly SidebarListItem[];
  strategy: SortingStrategy;
}) {
  const { active, over, droppableRects, droppableContainers } = useDndContext();
  const pinsRef = useRef<HTMLLIElement>(null);
  const projectRef = useRef<HTMLLIElement>(null);
  const { items, strategy } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the pin and project drop regions from dnd-kit's measured rects after layout
  useLayoutEffect(() => {
    const parent =
      active && droppableContainers.get(active.id)?.node.current?.closest(".sidebar-thread-list");
    if (!parent || !active) return;
    const activeIndex = items.findIndex((item) => sidebarListItemId(item) === active.id);
    const source = items[activeIndex];
    if (source?.kind !== "thread") return;
    const overIndex = items.findIndex((item) => sidebarListItemId(item) === over?.id);
    const rects = items.map((item) => droppableRects.get(sidebarListItemId(item)));
    if (rects.some((rect) => !rect)) return;
    const measured = rects as Parameters<SortingStrategy>[0]["rects"];
    const origin = parent.getBoundingClientRect();
    const sourceSection = source.section === "pinned" ? "active" : source.section;
    const target = resolveSidebarDropTarget(
      items,
      String(active.id),
      String(over?.id ?? active.id),
    );
    const headerIndex = items.findIndex(
      (item) =>
        item.kind === "project" &&
        item.projectKey === source.projectKey &&
        item.section === sourceSection,
    );
    let endIndex = headerIndex + 1;
    while (
      endIndex < items.length &&
      items[endIndex]?.projectKey === source.projectKey &&
      items[endIndex]?.kind !== "project"
    )
      endIndex++;
    const pinEnd = items.findIndex(
      (item) => item.kind === "marker" && item.marker === "pinned-divider",
    );
    for (const [node, start, end] of [
      [pinsRef.current, 0, pinEnd],
      [projectRef.current, headerIndex < 0 ? -1 : headerIndex + 1, endIndex],
    ] as const) {
      if (!node) continue;
      if (start < 0 || end <= start) {
        node.style.visibility = "hidden";
        continue;
      }
      const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
      if (
        node === pinsRef.current &&
        target?.section === "pinned" &&
        !indices.includes(activeIndex)
      )
        indices.push(activeIndex);
      const boxes = indices.flatMap((index) => {
        if (
          index === activeIndex &&
          target?.section !== (node === pinsRef.current ? "pinned" : sourceSection)
        )
          return [];
        const rect = measured[index]!;
        const transform = strategy({
          rects: measured,
          activeIndex,
          overIndex,
          index,
          activeNodeRect: measured[activeIndex]!,
        });
        return transform?.scaleY === 0 || rect.height === 0
          ? []
          : [
              {
                top: rect.top + (transform?.y ?? 0),
                bottom: rect.bottom + (transform?.y ?? 0),
                left: rect.left,
                width: rect.width,
              },
            ];
      });
      if (!boxes.length) {
        node.style.visibility = "hidden";
        continue;
      }
      const top = Math.min(...boxes.map((box) => box.top));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      Object.assign(node.style, {
        left: `${boxes[0]!.left - origin.left}px`,
        width: `${boxes[0]!.width}px`,
        top: `${top - origin.top}px`,
        height: `${bottom - top}px`,
        visibility: "visible",
      });
    }
  }, [active, over?.id, droppableRects, droppableContainers, items, strategy]);
  return (
    <>
      <li
        ref={pinsRef}
        aria-hidden
        inert
        data-sidebar-motion-skip
        data-testid="sidebar-pins-drag-region"
        className="pointer-events-none absolute z-0 rounded-md outline-1 -outline-offset-1 outline-primary/30"
        style={{ visibility: "hidden" }}
      />
      <li
        ref={projectRef}
        aria-hidden
        inert
        data-sidebar-motion-skip
        data-testid="sidebar-project-drag-region"
        className="pointer-events-none absolute z-0 rounded-md outline-1 -outline-offset-1 outline-primary/30"
        style={{ visibility: "hidden" }}
      />
    </>
  );
}

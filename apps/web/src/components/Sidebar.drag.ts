import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const hidden = { ...stationary, scaleY: 0 };
type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;
type Layout = Parameters<SortingStrategy>[0];
const isShelfHeader = (item: SidebarListItem | undefined) =>
  item?.kind === "marker" &&
  (item.marker === "working-header" ||
    item.marker === "snoozed-header" ||
    item.marker === "settled-header");

export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly SidebarListItem[];
    activationY?: number | null;
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, SidebarSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  return (args) => {
    const pointer = args.pointerCoordinates;
    const items = options.items;
    // The pointer chooses a slot, not the centre of the card picked up.
    const unified = items?.some((item) => item.kind === "project" && item.unified);
    let collisions = closestCenter(
      unified && pointer
        ? {
            ...args,
            collisionRect: {
              ...args.collisionRect,
              top: pointer.y,
              bottom: pointer.y,
              left: pointer.x,
              right: pointer.x,
              height: 0,
              width: 0,
            },
          }
        : args,
    );
    const source = items?.find((item) => item.kind === "thread" && item.key === args.active.id);
    const boundary = args.droppableContainers
      .find(
        (container) =>
          container.id ===
          sidebarMarkerId(
            "pinned-divider",
            unified && source?.kind === "thread" ? source.projectKey : undefined,
          ),
      )
      ?.node.current?.querySelector(".sidebar-drag-boundary-label")
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??= source.section === "pinned" ? "pinned" : "active";
      // Only pointer movement changes sections; opening the destination moves rows under stationary gestures.
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundarySection = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundarySection = "active";
        const nextHeader = (["working-header", "snoozed-header", "settled-header"] as const)
          .map((marker) =>
            args.droppableContainers.find((container) => container.id === sidebarMarkerId(marker)),
          )
          .find((container) => container !== undefined);
        const activeBottom = nextHeader?.node.current?.getBoundingClientRect().top;
        if (boundarySection === "pinned" || (activeBottom != null && pointer.y < activeBottom)) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!sections.has(id)) {
              sections.set(
                id,
                resolveSidebarDropTarget(items, String(args.active.id), id)?.section ?? null,
              );
            }
            return sections.get(id) === boundarySection;
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) {
      return collisions;
    }
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}

export function createSidebarSortingStrategy(input: {
  items: readonly SidebarListItem[];
  enabled?: boolean;
  settledOrder: readonly string[];
  activeOrder?: readonly string[];
  settledExpanded: boolean;
  settledVisibleCount?: number;
  routeThreadKey?: string | null;
  snoozedThreadCount?: number;
  cardHeight?: number;
  slimHeight?: number;
  boundaryLabelHeight?: number;
  /** Expose the reserved destination for the outlined slot, never a floating card. */
  includeActiveSlot?: boolean;
}): SortingStrategy {
  if (input.enabled === false) return () => stationary;
  const { items } = input;
  const indices = new Map(items.map((item, index) => [sidebarListItemId(item), index]));
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] | null = [];

  function project({ rects, activeIndex, overIndex }: Layout) {
    const active = items[activeIndex];
    const over = items[overIndex] ?? active;
    if (active?.kind !== "thread" || !over || !rects[0]) return [];
    const target = resolveSidebarDropTarget(items, active.key, sidebarListItemId(over));
    if (!target) return [];
    if (items.some((item) => item.kind === "project" && item.unified)) {
      // Pins and active rows share a fixed project footprint. Reorder only
      // that block: a gap after its last row belongs to the next header, not
      // to the row when it moves upward. Other projects never participate.
      const headerIndex = items.findIndex(
        (item) => item.kind === "project" && item.unified && item.projectKey === active.projectKey,
      );
      if (
        headerIndex >= 0 &&
        (active.section === "pinned" || active.section === "active") &&
        (target.section === "pinned" || target.section === "active")
      ) {
        let end = headerIndex + 1;
        while (
          end < items.length &&
          items[end]?.kind !== "project" &&
          items[end]?.projectKey === active.projectKey
        )
          end++;
        const block = items.slice(headerIndex + 1, end);
        const ranks = new Map(
          [...target.pinnedOrder, ...(input.activeOrder ?? target.activeOrder)].map(
            (key, index) => [key, index],
          ),
        );
        const rows = block.flatMap((item) =>
          item.kind === "thread"
            ? [{ ...item, section: item.key === active.key ? target.section : item.section }]
            : [],
        );
        rows.sort((a, b) => (ranks.get(a.key) ?? Infinity) - (ranks.get(b.key) ?? Infinity));
        const projected = [
          ...block.filter((item) => item.kind === "marker" && item.marker === "pinned-header"),
          ...rows.filter((item) => item.section === "pinned"),
          ...block.filter((item) => item.kind === "marker" && item.marker !== "pinned-header"),
          ...rows.filter((item) => item.section !== "pinned"),
        ];
        const result = items.map((item) =>
          item.kind === "project" && !item.visible ? hidden : stationary,
        );
        let top = rects[headerIndex + 1]?.top ?? rects[headerIndex]!.bottom;
        for (const [slot, item] of projected.entries()) {
          const index = indices.get(sidebarListItemId(item))!;
          const rect = rects[index];
          if (!rect) continue;
          result[index] = { ...stationary, y: top - rect.top };
          const original = rects[headerIndex + 1 + slot];
          const next = rects[headerIndex + 2 + slot];
          const gap = original && next ? Math.min(1, Math.max(0, next.top - original.bottom)) : 0;
          top += rect.height + gap;
        }
        if (!input.includeActiveSlot) result[activeIndex] = stationary;
        return result;
      }
      // Keep one measured header per project. Only the destination project
      // receives the lifted row; pins and active rows retain independent ranks.
      const pinnedRanks = new Map(target.pinnedOrder.map((key, index) => [key, index]));
      const activeRanks = new Map(
        (input.activeOrder ?? target.activeOrder).map((key, index) => [key, index]),
      );
      const settledRanks = new Map(input.settledOrder.map((key, index) => [key, index]));
      const floatingPinTarget =
        items[0]?.kind === "marker" &&
        items[0].marker === "pinned-header" &&
        rects[0].height > 0 &&
        rects[0].bottom <= (rects[1]?.top ?? 0);
      const projected: SidebarListItem[] = [];
      let index = 0;
      while (index < items.length) {
        const item = items[index++]!;
        if (floatingPinTarget && index === 1) continue;
        if (item.kind !== "project") {
          if (item.kind !== "thread" || item.key !== active.key) projected.push(item);
          continue;
        }
        const rows: ThreadItem[] = [];
        const markers: Extract<SidebarListItem, { kind: "marker" }>[] = [];
        let containsActive = false;
        while (index < items.length) {
          const child = items[index]!;
          if (child.kind === "thread") {
            if (child.key === active.key) containsActive = true;
            else rows.push(child);
          } else if (child.kind === "marker" && child.projectKey === item.projectKey) {
            markers.push(child);
          } else break;
          index++;
        }
        const destination =
          item.projectKey === active.projectKey &&
          (item.unified
            ? target.section === "pinned" || target.section === "active"
            : item.section === target.section);
        if (
          destination &&
          (item.expanded || input.routeThreadKey === active.key) &&
          (target.section !== "settled" ||
            input.settledExpanded ||
            input.routeThreadKey === active.key)
        )
          rows.push({ ...active, section: target.section });
        rows.sort((a, b) => {
          if (item.unified && a.section !== b.section) return a.section === "pinned" ? -1 : 1;
          const ranks =
            a.section === "pinned"
              ? pinnedRanks
              : a.section === "settled"
                ? settledRanks
                : activeRanks;
          return (ranks.get(a.key) ?? Infinity) - (ranks.get(b.key) ?? Infinity);
        });
        const count = item.threadCount - Number(containsActive) + Number(destination);
        if (item.unified || count > 0) {
          projected.push(item);
          if (markers.length === 0) projected.push(...rows);
          else {
            projected.push(...markers.filter((marker) => marker.marker === "pinned-header"));
            projected.push(...rows.filter((row) => row.section === "pinned"));
            projected.push(...markers.filter((marker) => marker.marker !== "pinned-header"));
            projected.push(...rows.filter((row) => row.section !== "pinned"));
          }
        }
      }
      const result = items.map(() => hidden);
      const scale = (rects[activeIndex]?.height ?? 36) / 36;
      const heightOf = (item: SidebarListItem) => {
        const rect = rects[indices.get(sidebarListItemId(item))!];
        if (item.kind === "project") return rect?.height || 48 * scale;
        if (
          item.kind === "marker" &&
          (item.marker === "pinned-header" || item.marker === "pinned-divider")
        )
          return (
            (item.projectKey === undefined || item.projectKey === active.projectKey
              ? (input.boundaryLabelHeight ?? 0)
              : 0) * scale
          );
        return rect?.height ?? 0;
      };
      const gapAfter = (item: SidebarListItem) => {
        const index = indices.get(sidebarListItemId(item));
        const rect = index === undefined ? undefined : rects[index];
        const next = index === undefined ? undefined : rects[index + 1];
        return rect && next && !isShelfHeader(items[index! + 1])
          ? Math.max(0, next.top - rect.bottom)
          : 1;
      };
      let top = floatingPinTarget ? rects[1]!.top : rects[0].top;
      const firstShelf = items.findIndex(isShelfHeader);
      const shelfGap =
        firstShelf > 0 && rects[firstShelf]!.top > rects[firstShelf - 1]!.bottom + 1
          ? Math.max(
              0,
              Math.max(...rects.map((rect) => rect?.bottom ?? 0)) -
                top -
                projected.reduce((sum, item) => sum + heightOf(item) + gapAfter(item), 0) -
                gapAfter(projected.at(-1)!),
            )
          : 0;
      let gapApplied = false;
      for (const item of projected) {
        const index = indices.get(sidebarListItemId(item));
        const rect = index === undefined ? undefined : rects[index];
        if (!gapApplied && isShelfHeader(item)) {
          top += shelfGap;
          gapApplied = true;
        }
        if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
        top += heightOf(item) + gapAfter(item);
      }
      if (!input.includeActiveSlot) result[activeIndex] = stationary;
      return result;
    }
    if (items.some((item) => item.kind === "project")) {
      type ProjectItem = Extract<SidebarListItem, { kind: "project" }>;
      const groups: { header: ProjectItem | null; section: SidebarSection; rows: ThreadItem[] }[] =
        [];
      let group: (typeof groups)[number] | undefined;
      for (const item of items) {
        if (item.kind === "marker") group = undefined;
        else if (item.kind === "project") {
          group = { header: item, section: item.section, rows: [] };
          groups.push(group);
        } else {
          if (!group) {
            group = { header: null, section: item.section, rows: [] };
            groups.push(group);
          }
          group.rows.push(item);
        }
      }
      const source = groups.find((group) => group.rows.some((row) => row.key === active.key));
      if (!source) return [];
      const destination = groups.find(
        (group) =>
          group.section === target.section &&
          group.header?.projectKey === source.header?.projectKey,
      );
      if (!destination) return [];
      const order =
        target.section === "pinned"
          ? target.pinnedOrder
          : target.section === "settled"
            ? input.settledOrder
            : (input.activeOrder ?? target.activeOrder);
      const ranks = new Map(order.map((key, index) => [key, index]));
      const settledVisible = new Set(
        input.settledExpanded
          ? input.settledOrder.slice(0, input.settledVisibleCount ?? input.settledOrder.length)
          : [],
      );
      if (input.routeThreadKey) settledVisible.add(input.routeThreadKey);
      const projected: SidebarListItem[] = [];
      const marker = (name: SidebarListMarker) => projected.push({ kind: "marker", marker: name });
      const appendGroups = (section: SidebarSection) => {
        let visibleCount = 0;
        for (const group of groups.filter((group) => group.section === section)) {
          const rows = group.rows.filter(
            (row) =>
              row.key !== active.key && (section !== "settled" || settledVisible.has(row.key)),
          );
          if (
            group === destination &&
            (group.header?.expanded !== false || input.routeThreadKey === active.key) &&
            (section !== "settled" || settledVisible.has(active.key))
          ) {
            rows.push({ ...active, section });
            rows.sort((a, b) => (ranks.get(a.key) ?? Infinity) - (ranks.get(b.key) ?? Infinity));
          }
          const count =
            (group.header?.threadCount ?? group.rows.length) -
            Number(group === source) +
            Number(group === destination);
          if (section === "settled" && !input.settledExpanded && rows.length === 0) continue;
          if (group.header && (section === "active" || count > 0)) {
            projected.push(group.header);
            visibleCount++;
          }
          projected.push(...rows);
          visibleCount += rows.length;
        }
        if (
          visibleCount === 0 &&
          (section === "active" || (section === "settled" && input.settledExpanded))
        ) {
          marker(`${section}-placeholder`);
        }
      };
      marker("pinned-header");
      appendGroups("pinned");
      marker("pinned-divider");
      appendGroups("active");
      for (const section of ["working", "snoozed", "settled"] as const) {
        if (!items.some((item) => item.kind === "marker" && item.marker === `${section}-header`))
          continue;
        if (
          section === "snoozed" &&
          active.section === "snoozed" &&
          (input.snoozedThreadCount ?? 0) <= 1
        )
          continue;
        marker(`${section}-header`);
        appendGroups(section);
      }
      const scale = (rects[activeIndex]?.height ?? 36) / 36;
      const heightOf = (item: SidebarListItem) => {
        if (item.kind === "project") return 48 * scale;
        if (item.kind === "thread") return rects[indices.get(item.key)!]?.height ?? 36 * scale;
        if (item.marker === "pinned-header" || item.marker === "pinned-divider") {
          return (input.boundaryLabelHeight ?? 0) * scale;
        }
        if (item.marker.endsWith("placeholder")) return 36 * scale;
        return rects[indices.get(sidebarListItemId(item))!]?.height ?? 32 * scale;
      };
      const firstShelf = items.findIndex(isShelfHeader);
      const shelfRect = rects[firstShelf];
      const beforeShelf = rects[firstShelf - 1];
      const bottom = Math.max(...rects.map((rect) => rect?.bottom ?? 0));
      let shelfSpace =
        shelfRect && beforeShelf && shelfRect.top > beforeShelf.bottom + 1
          ? Math.max(
              0,
              bottom - rects[0].top - projected.reduce((sum, item) => sum + heightOf(item) + 1, -1),
            )
          : 0;
      const result = items.map(() => hidden);
      let top = rects[0].top;
      for (const item of projected) {
        if (isShelfHeader(item)) {
          top += shelfSpace;
          shelfSpace = 0;
        }
        const index = indices.get(sidebarListItemId(item));
        const rect = index === undefined ? undefined : rects[index];
        if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
        top += heightOf(item) + 1;
      }
      if (!input.includeActiveSlot) result[activeIndex] = stationary;
      return result;
    }
    const groups: Record<SidebarSection, ThreadItem[]> = {
      pinned: [],
      active: [],
      working: [],
      snoozed: [],
      settled: [],
    };
    let cardHeight = input.cardHeight;
    let slimHeight = input.slimHeight;
    let headerScale: number | undefined;
    for (const [index, item] of items.entries()) {
      if (item.kind === "marker") {
        if (isShelfHeader(item)) {
          const height = rects[index]?.height;
          if (height) headerScale ??= height / 32;
        }
        continue;
      }
      if (item.kind !== "thread") continue;
      if (item.section === "pinned" || item.section === "active" || item.section === "working")
        cardHeight ??= rects[index]?.height;
      else slimHeight ??= rects[index]?.height;
      if (item.key !== active.key) groups[item.section].push(item);
    }
    const scale =
      slimHeight !== undefined ? slimHeight / 36 : (headerScale ?? (cardHeight ?? 82) / 82);
    cardHeight ??= 82 * scale;
    slimHeight ??= 36 * scale;
    const labelHeight = (input.boundaryLabelHeight ?? 0) * scale;
    const group = groups[target.section];
    const order =
      target.section === "pinned"
        ? target.pinnedOrder
        : target.section === "settled"
          ? input.settledOrder
          : (input.activeOrder ?? target.activeOrder);
    const ranks = new Map(order.map((key, index) => [key, index]));
    const rank = ranks.get(active.key) ?? Number.POSITIVE_INFINITY;
    const index = group.findIndex(
      (item) => (ranks.get(item.key) ?? Number.POSITIVE_INFINITY) > rank,
    );
    group.splice(index < 0 ? group.length : index, 0, { ...active, section: target.section });
    const settledOrder = (
      input.settledOrder.length > 0 ? input.settledOrder : groups.settled.map((item) => item.key)
    ).filter((key) => key !== active.key || target.section === "settled");
    const visible = input.settledExpanded
      ? settledOrder.slice(0, input.settledVisibleCount ?? settledOrder.length)
      : [];
    const routeKey = input.routeThreadKey;
    if (routeKey && settledOrder.includes(routeKey) && !visible.includes(routeKey)) {
      visible.push(routeKey);
    }
    groups.settled = visible.map((key) => ({ kind: "thread", key, section: "settled" }));
    const projected: SidebarListItem[] = [];
    const marker = (name: SidebarListMarker) => projected.push({ kind: "marker", marker: name });
    const section = (name: "active" | "settled") => {
      if (groups[name].length > 0) projected.push(...groups[name]);
      else marker(`${name}-placeholder`);
    };
    marker("pinned-header");
    projected.push(...groups.pinned);
    marker("pinned-divider");
    section("active");
    if (items.some((item) => item.kind === "marker" && item.marker === "working-header")) {
      marker("working-header");
      projected.push(...groups.working);
    }
    if (
      groups.snoozed.length > 0 ||
      ((active.section !== "snoozed" || (input.snoozedThreadCount ?? 0) > 1) &&
        items.some((item) => item.kind === "marker" && item.marker === "snoozed-header"))
    ) {
      marker("snoozed-header");
      projected.push(...groups.snoozed);
    }
    marker("settled-header");
    section("settled");
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const fallback =
        item.kind === "thread" &&
        (item.section === "pinned" || item.section === "active" || item.section === "working")
          ? cardHeight
          : slimHeight;
      const moved = item.kind === "thread" && item.key === active.key;
      return item.kind === "marker" &&
        (item.marker === "pinned-header" || item.marker === "pinned-divider")
        ? labelHeight
        : item.kind === "marker" && item.marker.endsWith("placeholder")
          ? slimHeight
          : moved
            ? fallback
            : (rect?.height ?? fallback);
    });
    const firstShelf = items.findIndex(isShelfHeader);
    const shelfRect = rects[firstShelf];
    const beforeShelf = rects[firstShelf - 1];
    const lastRect = rects.at(-1);
    let shelfSpace =
      shelfRect && beforeShelf && lastRect && shelfRect.top > beforeShelf.bottom + 1
        ? Math.max(
            0,
            lastRect.bottom - rects[0].top - heights.reduce((sum, height) => sum + height + 1, -1),
          )
        : 0;
    const result = items.map(() => hidden);
    let top = rects[0].top;
    for (const [projectedIndex, item] of projected.entries()) {
      if (isShelfHeader(item)) {
        top += shelfSpace;
        shelfSpace = 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      top += heights[projectedIndex]! + 1;
    }
    if (!input.includeActiveSlot) result[activeIndex] = stationary;
    return result;
  }

  return (args) => {
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== args.overIndex
    ) {
      previous = args;
      transforms = project(args);
    }
    return transforms === null
      ? verticalListSortingStrategy(args)
      : (transforms[args.index] ?? stationary);
  };
}

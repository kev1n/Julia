import { describe, expect, it } from "vite-plus/test";
import { createSidebarSortingStrategy } from "./Sidebar.drag";
import {
  planSidebarThreadDrop,
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  sidebarProjectHeaderId,
  type SidebarListItem,
} from "./Sidebar.logic";

const row = (key: string, projectKey: string, section: "pinned" | "active"): SidebarListItem => ({
  kind: "thread",
  key,
  projectKey,
  section,
});
const header = (projectKey: string): SidebarListItem => ({
  kind: "project",
  key: sidebarProjectHeaderId("active", projectKey),
  projectKey,
  section: "active",
  expanded: true,
  visible: true,
  threadCount: 2,
});
const marker = (
  name:
    | "pinned-header"
    | "pinned-placeholder"
    | "pinned-divider"
    | "active-placeholder"
    | "draft-block",
  projectKey?: string,
): SidebarListItem => ({
  kind: "marker",
  marker: name,
  projectKey,
  ...(name === "pinned-header" ? { sharedPins: true } : {}),
});
const items = [
  marker("pinned-header"),
  row("p-pin", "p", "pinned"),
  row("q-pin", "q", "pinned"),
  marker("pinned-placeholder"),
  marker("pinned-divider"),
  header("p"),
  marker("active-placeholder", "p"),
  marker("draft-block", "p"),
  row("a", "p", "active"),
  row("b", "p", "active"),
  header("q"),
  marker("active-placeholder", "q"),
  marker("draft-block", "q"),
  row("other", "q", "active"),
];

function layout(
  list: readonly SidebarListItem[],
  active: string,
  over: string,
  emptyTarget = false,
) {
  let top = 108;
  const rects = list.map((item) => {
    const height =
      item.kind === "thread"
        ? 36
        : item.kind === "project"
          ? 48
          : item.marker === "pinned-header"
            ? 32
            : emptyTarget && item.marker === "pinned-placeholder"
              ? 36
              : 0;
    const rect = { top, bottom: top + height, left: 8, right: 247, width: 239, height };
    top += height + (height > 0 ? 1 : 0);
    return rect;
  });
  const activeIndex = list.findIndex((item) => sidebarListItemId(item) === active);
  return {
    rects,
    activeIndex,
    overIndex: list.findIndex((item) => sidebarListItemId(item) === over),
    activeNodeRect: rects[activeIndex]!,
    index: activeIndex,
  };
}

const strategyFor = (list: readonly SidebarListItem[]) =>
  createSidebarSortingStrategy({
    items: list,
    settledExpanded: false,
    settledOrder: [],
    includeActiveSlot: true,
  });

function expectNoOverlap(
  list: readonly SidebarListItem[],
  active: string,
  over: string,
  empty = false,
) {
  const args = layout(list, active, over, empty);
  const strategy = strategyFor(list);
  const boxes = list
    .flatMap((_, index) => {
      const transform = strategy({ ...args, index })!;
      const rect = args.rects[index]!;
      return transform.scaleY === 0 || rect.height === 0
        ? []
        : [{ top: rect.top + transform.y, bottom: rect.bottom + transform.y }];
    })
    .sort((a, b) => a.top - b.top);
  for (let index = 1; index < boxes.length; index++)
    expect(boxes[index]!.top).toBeGreaterThanOrEqual(boxes[index - 1]!.bottom);
  return { args, strategy };
}

describe("shared Pins shelf", () => {
  it("reorders pins from different projects without changing their project membership", () => {
    const target = resolveSidebarDropTarget(items, "q-pin", "p-pin")!;
    expect(target).toMatchObject({ section: "pinned", pinnedOrder: ["q-pin", "p-pin"] });
    const plan = planSidebarThreadDrop({
      activeKey: "q-pin",
      activeSection: "pinned",
      target,
      pinnedOrder: ["p-pin", "q-pin"],
      pinnedKeysById: new Map([
        ["p-pin", "a0"],
        ["q-pin", "a1"],
      ]),
      activeOrder: ["a", "b", "other"],
      activeKeysById: new Map(),
      projectThreadKeys: new Set(["q-pin", "other"]),
    });
    expect(plan.kind).toBe("reorder-pinned");
    if (plan.kind !== "reorder-pinned") return;
    expect(plan.order).toEqual(["q-pin", "p-pin"]);
    const committedKeys = new Map([
      ["p-pin", "a0"],
      ["q-pin", "a1"],
    ]);
    for (const { id, orderKey } of plan.assignments) committedKeys.set(id, orderKey);
    expect(committedKeys.get("q-pin")! < committedKeys.get("p-pin")!).toBe(true);
    expect(items.find((item) => item.kind === "thread" && item.key === "q-pin")?.projectKey).toBe(
      "q",
    );
    expectNoOverlap(items, "q-pin", "p-pin");
  });

  it.each([sidebarMarkerId("pinned-header"), "q-pin"])(
    "pins into the global shelf over %s",
    (over) => {
      expect(resolveSidebarDropTarget(items, "b", over)?.section).toBe("pinned");
      expectNoOverlap(items, "b", over);
    },
  );

  it("opens a real empty pin destination without overlapping the first project", () => {
    const empty = items.filter((item) => item.kind !== "thread" || item.section !== "pinned");
    expect(
      resolveSidebarDropTarget(empty, "b", sidebarMarkerId("pinned-placeholder")),
    ).toMatchObject({ section: "pinned", pinnedOrder: ["b"] });
    expectNoOverlap(empty, "b", sidebarMarkerId("pinned-placeholder"), true);
  });

  it.each([
    "other",
    sidebarProjectHeaderId("active", "q"),
    sidebarMarkerId("active-placeholder", "q"),
  ])("rejects unpinned foreign-project destination %s", (over) => {
    expect(resolveSidebarDropTarget(items, "b", over)).toBeNull();
    expect(resolveSidebarDropTarget(items, "p-pin", over)).toBeNull();
  });

  it("returns a pin only to its own project", () => {
    expect(
      resolveSidebarDropTarget(items, "p-pin", sidebarProjectHeaderId("active", "p"))?.section,
    ).toBe("active");
    expectNoOverlap(items, "p-pin", sidebarProjectHeaderId("active", "p"));
  });

  it("moving the last row upward does not move the next project's header", () => {
    const { args, strategy } = expectNoOverlap(items, "b", "a");
    const next = items.findIndex((item) => item.kind === "project" && item.projectKey === "q");
    expect(strategy({ ...args, index: next })?.y).toBe(0);
  });
});

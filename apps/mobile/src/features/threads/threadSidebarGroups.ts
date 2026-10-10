import { useCallback, useState } from "react";

import type { HomeProjectScope } from "../home/homeThreadList";
import type { ThreadListV2ListItem } from "./threadListV2";

export type SidebarRow =
  | ThreadListV2ListItem
  | {
      readonly type: "v2-show-more";
      readonly key: string;
      readonly hiddenCount: number;
      readonly state?: "loading" | "failed";
    };
export type GroupedSidebarRow =
  | SidebarRow
  | {
      readonly type: "project-header";
      readonly key: string;
      /** Collapse state is per section, as on web: folding a project's
          settled threads leaves its active ones open. */
      readonly collapseKey: string;
      readonly scope: HomeProjectScope;
      readonly count: number;
      readonly expanded: boolean;
    };

const SHELF_SECTION = {
  "v2-working-shelf": "working",
  "v2-snoozed-shelf": "snoozed",
  "v2-settled-shelf": "settled",
} as const;

/** Group each lifecycle block without moving shelves or offline pending tasks.
    Pins stay one shelf across projects, as in the web sidebar. */
export function groupThreadSidebarItems(input: {
  items: readonly SidebarRow[];
  scopes: readonly HomeProjectScope[];
  collapsedKeys: ReadonlySet<string>;
  selectedThreadKey: string | null;
}): GroupedSidebarRow[] {
  const scopeByRef = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map((ref) => [`${ref.environmentId}:${ref.projectId}`, scope] as const),
    ),
  );
  const output: GroupedSidebarRow[] = [];
  let block: Extract<SidebarRow, { type: "v2-thread" }>[] = [];
  let section = "active";
  const flush = () => {
    if (block.length === 0) return;
    const buckets = new Map<string, typeof block>();
    const ungrouped: typeof block = [];
    for (const row of block) {
      const thread = row.item.thread;
      const scope = scopeByRef.get(`${thread.environmentId}:${thread.projectId}`);
      if (!scope) {
        ungrouped.push(row);
        continue;
      }
      const bucket = buckets.get(scope.key) ?? [];
      bucket.push(row);
      buckets.set(scope.key, bucket);
    }
    for (const scope of input.scopes) {
      const rows = buckets.get(scope.key);
      if (!rows) continue;
      const collapseKey = `${section}:${scope.key}`;
      const expanded = !input.collapsedKeys.has(collapseKey);
      output.push({
        type: "project-header",
        key: `project:${collapseKey}`,
        collapseKey,
        scope,
        count: rows.length,
        expanded,
      });
      output.push(
        ...rows.filter(
          (row) =>
            expanded ||
            `${row.item.thread.environmentId}:${row.item.thread.id}` === input.selectedThreadKey,
        ),
      );
    }
    output.push(...ungrouped);
    block = [];
  };
  for (const row of input.items) {
    if (row.type === "v2-thread" && !row.item.pinned) {
      block.push(row);
    } else {
      flush();
      if (row.type in SHELF_SECTION)
        section = SHELF_SECTION[row.type as keyof typeof SHELF_SECTION];
      output.push(row);
    }
  }
  flush();
  return output;
}

/** Collapsed `collapseKey`s for `groupThreadSidebarItems`, and their toggle. */
export function useCollapsedProjectKeys() {
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((collapseKey: string) => {
    setCollapsedKeys((keys) => {
      const next = new Set(keys);
      if (!next.delete(collapseKey)) next.add(collapseKey);
      return next;
    });
  }, []);
  return [collapsedKeys, toggle] as const;
}

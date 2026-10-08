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
      readonly scope: HomeProjectScope;
      readonly count: number;
      readonly expanded: boolean;
    };

/** Group each lifecycle block without moving shelves or offline pending tasks. */
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
  let ordinal = 0;
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
      const expanded = !input.collapsedKeys.has(scope.key);
      output.push({
        type: "project-header",
        key: `project:${ordinal}:${scope.key}`,
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
    ordinal++;
  };
  for (const row of input.items) {
    if (row.type === "v2-thread") {
      block.push(row);
    } else {
      flush();
      output.push(row);
    }
  }
  flush();
  return output;
}

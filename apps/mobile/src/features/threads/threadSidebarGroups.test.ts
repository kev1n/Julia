import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { makeThreadShellFixture } from "../../test-fixtures";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { buildThreadListV2Items, buildThreadListV2ListItems } from "./threadListV2";
import { groupThreadSidebarItems } from "./threadSidebarGroups";

const environmentId = EnvironmentId.make("local");
const projects: EnvironmentProject[] = ["p", "q"].map((id) => ({
  id: ProjectId.make(id),
  environmentId,
  title: id,
  workspaceRoot: `/projects/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));
const scopes = buildHomeProjectScopes({ projects, environmentId, projectGroupingMode: "separate" });
const threads = [
  { id: "pin-p", projectId: "p", pinnedAt: "2026-01-02T00:00:00.000Z" },
  { id: "pin-q", projectId: "q", pinnedAt: "2026-01-02T00:00:00.000Z" },
  { id: "active-p", projectId: "p", pinnedAt: null },
  { id: "active-q", projectId: "q", pinnedAt: null },
].map((input) =>
  makeThreadShellFixture({
    ...input,
    environmentId,
    id: ThreadId.make(input.id),
    projectId: ProjectId.make(input.projectId),
    title: input.id,
  }),
);
const layout = buildThreadListV2Items({
  threads,
  environmentId,
  searchQuery: "",
  now: "2026-01-03T00:00:00.000Z",
});
const items = buildThreadListV2ListItems({
  items: layout.items,
  pendingTasks: [],
  settledCount: 0,
  settledShelfHeaderIndex: null,
});

it("keeps pins first under a single heading per project", () => {
  const grouped = groupThreadSidebarItems({
    items,
    scopes,
    collapsedKeys: new Set(),
    selectedThreadKey: null,
  });
  expect(
    grouped.map((row) =>
      row.type === "project-header"
        ? row.scope.title
        : row.type === "v2-thread"
          ? row.item.thread.id
          : row.type,
    ),
  ).toEqual(["p", "pin-p", "active-p", "q", "pin-q", "active-q"]);
});

it("collapses pins and active rows together, retaining the selected thread", () => {
  const grouped = groupThreadSidebarItems({
    items,
    scopes,
    collapsedKeys: new Set([scopes[0]!.key]),
    selectedThreadKey: "local:active-p",
  });
  expect(
    grouped.filter((row) => row.type === "v2-thread").map((row) => row.item.thread.id),
  ).toEqual(["active-p", "pin-q", "active-q"]);
  expect(grouped.filter((row) => row.type === "project-header").map((row) => row.count)).toEqual([
    2, 2,
  ]);
});

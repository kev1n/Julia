import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { shallow } from "zustand/shallow";
import { DraftId, markPromotedDraftThreadByRef, useComposerDraftStore } from "./composerDraftStore";
import { countSidebarDraftSessions, selectSidebarDraftSessionKeys } from "./sidebarDraftSessions";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const all = { routeDraftId: null, scopedProjectKeys: null };
const reset = () =>
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
beforeEach(reset);
afterEach(reset);

function start(id: string, environmentId = local, minute = "00") {
  const draftId = DraftId.make(id);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
      threadId: ThreadId.make(`thread-${id}`),
      createdAt: `2026-10-07T12:${minute}:00.000Z`,
    });
  return draftId;
}

it("keeps older invested drafts under the project after a new draft replaces the mapping", () => {
  const old = start("old");
  useComposerDraftStore.getState().setPrompt(old, "Investigate results");
  const recent = start("recent", local, "01");
  useComposerDraftStore.getState().setPrompt(recent, "Compare providers");
  expect(selectSidebarDraftSessionKeys(useComposerDraftStore.getState(), all)).toEqual([
    recent,
    old,
  ]);
  expect(
    countSidebarDraftSessions(useComposerDraftStore.getState(), all).get("local:project"),
  ).toBe(2);
});

it("uses physical environment/project membership, including merged remote members", () => {
  const first = start("first");
  useComposerDraftStore.getState().setPrompt(first, "Local work");
  const second = start("second", remote, "01");
  useComposerDraftStore.getState().setPrompt(second, "Remote work");
  expect(
    selectSidebarDraftSessionKeys(useComposerDraftStore.getState(), {
      ...all,
      scopedProjectKeys: new Set(["local:project"]),
    }),
  ).toEqual([first]);
  expect(
    selectSidebarDraftSessionKeys(useComposerDraftStore.getState(), {
      ...all,
      scopedProjectKeys: new Set(["local:project", "remote:project"]),
    }),
  ).toEqual([second, first]);
  expect(
    selectSidebarDraftSessionKeys(useComposerDraftStore.getState(), {
      ...all,
      excludedProjectKeys: new Set(["local:project", "remote:project"]),
    }),
  ).toEqual([]);
});

it("keeps the selected empty draft visible in a collapsed project, then removes promoted or discarded drafts", () => {
  const invested = start("invested");
  useComposerDraftStore.getState().setPrompt(invested, "Keep my prompt");
  const selected = start("selected", local, "01");
  const input = { ...all, routeDraftId: selected, expanded: false };
  expect(selectSidebarDraftSessionKeys(useComposerDraftStore.getState(), input)).toEqual([
    selected,
  ]);
  markPromotedDraftThreadByRef(scopeThreadRef(local, ThreadId.make("thread-selected")));
  expect(selectSidebarDraftSessionKeys(useComposerDraftStore.getState(), input)).toEqual([]);
  expect(selectSidebarDraftSessionKeys(useComposerDraftStore.getState(), all)).toEqual([invested]);
  useComposerDraftStore.getState().clearDraftThread(invested);
  expect(selectSidebarDraftSessionKeys(useComposerDraftStore.getState(), all)).toEqual([]);
});

it("counts attachment-only drafts and keeps the count subscription stable during typing", () => {
  const draft = start("attachment");
  useComposerDraftStore.getState().addFiles(draft, [
    {
      type: "file",
      id: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      file: new File(["notes"], "notes.txt", { type: "text/plain" }),
    },
  ]);
  const before = countSidebarDraftSessions(useComposerDraftStore.getState(), all);
  expect(before.get("local:project")).toBe(1);
  useComposerDraftStore.getState().setPrompt(draft, "Review these notes");
  expect(shallow(before, countSidebarDraftSessions(useComposerDraftStore.getState(), all))).toBe(
    true,
  );
});

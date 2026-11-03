import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { Route as IndexRoute } from "../routes/_chat.index";
import { makeThreadFixture } from "../test-fixtures";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import type { Project, Thread } from "../types";
import { ThreadRouteView } from "./ThreadRouteView";

type Navigation = {
  to: string;
  params?: Record<string, string>;
  search?: { startDraft?: false };
};
const state = vi.hoisted(() => ({
  projects: [] as Project[],
  threads: [] as Thread[],
  search: {} as { startDraft?: false },
  navigate: vi.fn<(input: Navigation) => Promise<void>>(),
  startDraft:
    vi.fn<(ref: ScopedProjectRef) => Promise<{ draftId: DraftId; threadId: ThreadId } | null>>(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => {
  const { useLayoutEffect: useNavigateEffect } = await import("react");
  return {
    ...(await original()),
    useNavigate: (() => state.navigate) as never,
    // The router's own Navigate calls its internal useNavigate, which the mock above cannot reach.
    Navigate: ((props: Navigation) => {
      useNavigateEffect(() => void state.navigate(props), [props]);
      return null;
    }) as never,
    useRouter: (() => ({ state: { location: { pathname: "/" } } })) as never,
    Link: (() => null) as never,
    createFileRoute: (() => (options: { component: () => ReactNode }) => ({
      options,
      useRouteContext: () => ({ authGateState: { status: "authenticated" } }),
      useSearch: () => state.search,
    })) as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  readProject: ((ref: ScopedProjectRef) =>
    state.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    ) ?? null) as never,
  useThreadShells: (() => state.threads) as never,
  readThreadShells: (() => state.threads) as never,
  useAllEnvironmentShellsBootstrapped: () => true,
  useThreadRefs: (() =>
    state.threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id))) as never,
  useEnvironmentThreadRefs: () => [],
  useQuietThreadShell: ((ref: ScopedThreadRef | null) =>
    state.threads.find(
      (thread) => thread.environmentId === ref?.environmentId && thread.id === ref.threadId,
    ) ?? null) as never,
}));
vi.mock(import("../state/shell"), async (original) => ({
  ...(await original()),
  useEnvironmentShellStatus: () => "live",
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [], isReady: true })) as never,
}));
vi.mock(import("../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => state.startDraft) as never,
}));
vi.mock(import("../env"), async (original) => ({ ...(await original()), isElectron: false }));
vi.mock(import("../localEnvironment"), async (original) => ({
  ...(await original()),
  isLocalEnvironmentDisabled: () => false,
}));
vi.mock("~/cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => false,
}));
vi.mock("./ChatView", () => ({ default: () => null }));
vi.mock(import("./ChatView.logic"), async (original) => ({
  ...(await original()),
  resolveDraftPromotionNavigationTarget: () => null,
  threadHasStarted: () => false,
}));
vi.mock("./NoProjectsHero", () => ({ NoProjectsHero: () => null }));
vi.mock("./WorkspacePageHeader", () => ({ WorkspacePageHeader: () => null }));
vi.mock(import("./ui/sidebar"), async (original) => ({
  ...(await original()),
  SidebarInset: (({ children }: { children: ReactNode }) => children) as never,
}));

const environmentId = EnvironmentId.make("local");
const catalog = scopeProjectRef(environmentId, ProjectId.make("catalog"));
const draftId = DraftId.make("catalog-draft");

function Harness({ initialTarget }: { initialTarget: ThreadRouteTarget | null }) {
  const [target, setTarget] = useState(initialTarget);
  useLayoutEffect(() => {
    state.navigate.mockImplementation(async (input) => {
      state.search = input.search ?? {};
      setTarget(resolveThreadRouteTarget(input.params ?? {}));
    });
  }, []);
  const Index = IndexRoute.options.component!;
  return target ? <ThreadRouteView target={target} /> : <Index />;
}

async function setup() {
  // The router plugin code-splits route components; load the index chunk up front so
  // the home screen mounts within render() like the rest of the tree.
  await IndexRoute.options.component!.preload?.();
  state.navigate.mockReset();
  state.startDraft
    .mockReset()
    .mockResolvedValue({ draftId, threadId: ThreadId.make("thread:t3-fork-draft") });
  state.search = {};
  state.threads = [];
  state.projects = ["t3-fork", "catalog"].map((id) => ({
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/workspace/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: id === "t3-fork" ? "2026-10-08T00:00:00Z" : "2026-10-01T00:00:00Z",
  }));
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  useComposerDraftStore.getState().setProjectDraftThreadId(catalog, draftId);
}

async function closeDraft() {
  const screen = await render(<Harness initialTarget={{ kind: "draft", draftId }} />);
  try {
    await act(() => useComposerDraftStore.getState().clearDraftThread(draftId));
  } catch (error) {
    await screen[Symbol.asyncDispose]();
    throw error;
  }
  return screen;
}

it("does not create a t3-fork draft when the catalog draft is closed", async () => {
  await setup();
  await using _screen = await closeDraft();
  expect(state.startDraft).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
});

it("returns to the latest existing thread in the draft's project", async () => {
  await setup();
  const latest = makeThreadFixture({
    environmentId,
    projectId: catalog.projectId,
    id: ThreadId.make("catalog-latest"),
    updatedAt: "2026-10-07T00:00:00Z",
  });
  state.threads = [
    makeThreadFixture({
      environmentId,
      projectId: catalog.projectId,
      id: ThreadId.make("catalog-old"),
    }),
    latest,
    makeThreadFixture({
      environmentId,
      projectId: ProjectId.make("t3-fork"),
      updatedAt: "2026-10-08T00:00:00Z",
    }),
    makeThreadFixture({
      environmentId,
      projectId: catalog.projectId,
      id: ThreadId.make("archived"),
      archivedAt: "2026-10-08T00:00:00Z",
      updatedAt: "2026-10-08T00:00:00Z",
    }),
    makeThreadFixture({
      environmentId: EnvironmentId.make("remote"),
      projectId: catalog.projectId,
      updatedAt: "2026-10-08T00:00:00Z",
    }),
    makeThreadFixture({
      environmentId,
      projectId: catalog.projectId,
      id: ThreadId.make("deleted"),
      deletedAt: "2026-10-08T00:00:00Z",
      updatedAt: "2026-10-08T00:00:00Z",
    }),
  ];
  await using _screen = await closeDraft();
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: latest.id },
    replace: true,
  });
  expect(state.startDraft).not.toHaveBeenCalled();
});

it("does not reopen archived or deleted threads when closing a draft", async () => {
  await setup();
  state.threads = [
    makeThreadFixture({
      environmentId,
      projectId: catalog.projectId,
      archivedAt: "2026-10-08T00:00:00Z",
    }),
    makeThreadFixture({
      environmentId,
      projectId: catalog.projectId,
      deletedAt: "2026-10-08T00:00:00Z",
    }),
  ];
  await using _screen = await closeDraft();
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/",
    search: { startDraft: false },
    replace: true,
  });
  expect(state.startDraft).not.toHaveBeenCalled();
});

it("does not create a draft when a discarded draft URL is reopened", async () => {
  await setup();
  useComposerDraftStore.getState().clearDraftThread(draftId);
  await using _screen = await render(<Harness initialTarget={{ kind: "draft", draftId }} />);
  expect(state.startDraft).not.toHaveBeenCalled();
});

it("still starts a draft on a normal home-screen visit", async () => {
  await setup();
  await using _screen = await render(<Harness initialTarget={null} />);
  expect(state.startDraft).toHaveBeenCalledWith(
    scopeProjectRef(environmentId, ProjectId.make("t3-fork")),
    { replace: true },
  );
});

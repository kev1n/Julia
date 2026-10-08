import { describe, expect, it, beforeEach } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  freshThreadProject,
  freshThreadCloneUrl,
  freshThreadClonedProjectPath,
  completeFreshThreadProjectSetup,
} from "./freshThreadProject";

const source: EnvironmentProject = {
  id: ProjectId.make("source"),
  environmentId: EnvironmentId.make("offline"),
  title: "app",
  workspaceRoot: "/offline/repo/apps/web",
  scripts: [],
  defaultModelSelection: null,
  createdAt: "2026-10-08T03:00:00Z",
  updatedAt: "2026-10-08T03:00:00Z",
  repositoryIdentity: {
    canonicalKey: "github.com/example/repo",
    rootPath: "/offline/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/example/repo.git",
    },
  },
};
const healthy = EnvironmentId.make("healthy");
const destination: EnvironmentProject = {
  ...source,
  id: ProjectId.make("destination"),
  environmentId: healthy,
  workspaceRoot: "/healthy/repo/apps/web",
  repositoryIdentity: { ...source.repositoryIdentity!, rootPath: "/healthy/repo" },
};

describe("fresh thread project destinations", () => {
  it("matches registered repository and subdirectory regardless of source availability or root path", () => {
    expect(freshThreadProject(source, [source, destination], healthy)).toBe(destination);
  });
  it("does not route a monorepo project to its root or a sibling project", () => {
    expect(
      freshThreadProject(source, [{ ...destination, workspaceRoot: "/healthy/repo" }], healthy),
    ).toBeNull();
    expect(
      freshThreadProject(
        source,
        [{ ...destination, workspaceRoot: "/healthy/repo/apps/server" }],
        healthy,
      ),
    ).toBeNull();
  });
  it("requires setup on a paired machine with no registered counterpart", () => {
    expect(freshThreadProject(source, [source], healthy)).toBeNull();
  });
  it("does not guess a counterpart for a plain folder or an unknown repository root", () => {
    expect(
      freshThreadProject({ ...source, repositoryIdentity: null }, [destination], healthy),
    ).toBeNull();
    const { rootPath: _root, ...identity } = source.repositoryIdentity!;
    expect(
      freshThreadProject({ ...source, repositoryIdentity: identity }, [destination], healthy),
    ).toBeNull();
  });
  it("distinguishes forks that share an upstream", () => {
    const fork = {
      ...source,
      repositoryIdentity: {
        ...source.repositoryIdentity!,
        origin: { canonicalKey: "github.com/me/repo" },
      },
    };
    expect(freshThreadProject(fork, [destination], healthy)).toBeNull();
  });
  it("keeps the offline source visible", () => {
    expect(freshThreadProject(source, [], source.environmentId)).toBe(source);
  });
  it("uses a cached clone locator, but never clones an upstream in place of its fork", () => {
    expect(freshThreadCloneUrl(source)).toBe("https://github.com/example/repo.git");
    expect(
      freshThreadCloneUrl({
        ...source,
        repositoryIdentity: {
          ...source.repositoryIdentity!,
          locator: { ...source.repositoryIdentity!.locator, remoteName: "upstream" },
          origin: { canonicalKey: "github.com/me/repo" },
        },
      }),
    ).toBeNull();
    expect(freshThreadCloneUrl({ ...source, repositoryIdentity: null })).toBeNull();
  });
});

describe("explicit fresh draft destination setup", () => {
  const draftId = DraftId.make("original-draft");
  const setup = { environmentId: healthy, draftId, sourceProject: source };
  const destinationRef = scopeProjectRef(healthy, destination.id);
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    const store = useComposerDraftStore.getState();
    store.setLogicalProjectDraftThreadId(
      "original-logical-project",
      scopeProjectRef(source.environmentId, source.id),
      draftId,
      {
        threadId: ThreadId.make("original-thread"),
        branch: "source-branch",
        worktreePath: "/offline/worktree",
        envMode: "worktree",
        startFromOrigin: true,
      },
    );
    store.setPrompt(draftId, "Keep this unsent task");
  });
  it("registers the intended relative folder, not the source machine's absolute path", () => {
    expect(freshThreadClonedProjectPath(source, "/destination/clone")).toBe(
      "/destination/clone/apps/web",
    );
    expect(freshThreadClonedProjectPath(source, "C:\\destination\\clone")).toBe(
      "C:\\destination\\clone\\apps\\web",
    );
    expect(
      freshThreadClonedProjectPath({ ...source, repositoryIdentity: null }, "/destination/clone"),
    ).toBeNull();
  });
  it("retargets only the same local draft, preserving content and workspace intent", () => {
    expect(completeFreshThreadProjectSetup(setup, destinationRef, draftId)).toBe(true);
    const store = useComposerDraftStore.getState();
    expect(store.getDraftSession(draftId)).toMatchObject({
      threadId: "original-thread",
      environmentId: healthy,
      projectId: destination.id,
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
      environmentSelection: "manual",
    });
    expect(store.getComposerDraft(draftId)?.prompt).toBe("Keep this unsent task");
  });
  it("ignores setup completing after navigation away", () => {
    expect(completeFreshThreadProjectSetup(setup, destinationRef, null)).toBe(false);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(
      source.environmentId,
    );
  });
  it("ignores setup completing after a newer machine choice", () => {
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(healthy, ProjectId.make("newer-choice")),
    });
    expect(completeFreshThreadProjectSetup(setup, destinationRef, draftId)).toBe(false);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.projectId).toBe(
      "newer-choice",
    );
  });
  it("never moves a draft already promoted to a durable server thread", () => {
    useComposerDraftStore.getState().markDraftThreadPromoting(draftId, {
      environmentId: source.environmentId,
      threadId: ThreadId.make("original-thread"),
    });
    expect(completeFreshThreadProjectSetup(setup, destinationRef, draftId)).toBe(false);
  });
  it("does not register or retarget on a different machine than the explicit choice", () => {
    expect(
      completeFreshThreadProjectSetup(
        setup,
        scopeProjectRef(source.environmentId, source.id),
        draftId,
      ),
    ).toBe(false);
  });
});

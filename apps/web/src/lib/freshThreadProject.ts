import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { deriveRepositoryRelativeProjectPath } from "@t3tools/client-runtime/state/project-grouping";
import {
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import type { CommandPaletteProjectSetup } from "../commandPaletteBus";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
} from "@t3tools/client-runtime/state/projects";

/** Fresh destinations match checkouts, not the user's sidebar grouping preference. */
export function freshThreadProject(
  source: EnvironmentProject,
  projects: readonly EnvironmentProject[],
  environmentId: EnvironmentId,
): EnvironmentProject | null {
  if (environmentId === source.environmentId) return source;
  const relativePath = deriveRepositoryRelativeProjectPath(source);
  if (!source.repositoryIdentity || relativePath === null) return null;
  const repository = repositoryGroupingKeyOf(source.repositoryIdentity);
  return (
    projects.find(
      (project) =>
        project.environmentId === environmentId &&
        project.repositoryIdentity != null &&
        repositoryGroupingKeyOf(project.repositoryIdentity) === repository &&
        deriveRepositoryRelativeProjectPath(project) === relativePath,
    ) ?? null
  );
}

/** Do not suggest cloning an upstream remote in place of its fork. Ask for a URL instead. */
export function freshThreadCloneUrl(source: EnvironmentProject): string | null {
  const identity = source.repositoryIdentity;
  if (!identity || (identity.origin && identity.locator.remoteName !== "origin")) return null;
  return identity.locator.remoteUrl;
}

/** A clone's registration must preserve a monorepo project's relative folder. */
export function freshThreadClonedProjectPath(
  source: EnvironmentProject,
  cloneRoot: string,
): string | null {
  const relativePath = deriveRepositoryRelativeProjectPath(source);
  if (relativePath === null) return null;
  return relativePath
    ? relativePath
        .split("/")
        .reduce(
          (path, segment) => appendBrowsePathSegment(path, segment),
          ensureBrowseDirectoryPath(cloneRoot),
        )
        .replace(/[\\/]+$/, "")
    : cloneRoot;
}

/** Destination setup must not overwrite another navigation, promotion, or machine choice. */
export function completeFreshThreadProjectSetup(
  setup: CommandPaletteProjectSetup,
  projectRef: ScopedProjectRef,
  routeDraftId: DraftId | null,
): boolean {
  const store = useComposerDraftStore.getState();
  const draft = store.getDraftSession(setup.draftId);
  if (
    routeDraftId !== setup.draftId ||
    projectRef.environmentId !== setup.environmentId ||
    !draft ||
    draft.promotedTo ||
    draft.environmentId !== setup.sourceProject.environmentId ||
    draft.projectId !== setup.sourceProject.id
  )
    return false;
  store.setDraftThreadContext(setup.draftId, {
    projectRef,
    environmentSelection: "manual",
    loadBalancedEnvironmentId: null,
  });
  return true;
}

export { deriveRepositoryRelativeProjectPath };

import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  type ProjectId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import { freshThreadProject } from "../lib/freshThreadProject";
import { useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

/**
 * The environments a project (or a scratch draft) can move between. Fork: a draft lists
 * every paired machine, including ones that still need the project set up. It reads only the
 * environment, project and grouping inputs, so the list keeps its identity while the thread
 * streams and the chat chrome it feeds can skip those renders.
 */
export function useLogicalProjectEnvironments(
  activeProject: EnvironmentProject | null,
  scratchDraft: boolean,
  draft: boolean,
): readonly EnvironmentOption[] {
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  if (!activeProject) return [];
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const envs: EnvironmentOption[] = [];
  const pushEnvironment = (environmentId: EnvironmentId, projectId: ProjectId | null) => {
    const environment = environmentById.get(environmentId) ?? null;
    envs.push({
      environmentId,
      projectId,
      label: environment?.label ?? environmentId,
      isPrimary: environmentId === primaryEnvironmentId,
      machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
      ...(draft && !scratchDraft
        ? {
            detail:
              environment?.connection.phase === "connected"
                ? projectId === null
                  ? "Project setup required"
                  : "Project ready"
                : "Not connected",
            disabled:
              environment?.connection.phase !== "connected" &&
              environmentId !== activeProject.environmentId,
          }
        : {}),
    });
  };
  if (scratchDraft) {
    for (const environment of environments) {
      const scratchRoot = availableScratchWorkspaceRoot(
        environment.connection.phase,
        environment.serverConfig,
      );
      if (scratchRoot === null && environment.environmentId !== activeProject.environmentId)
        continue;
      const scratchProject =
        environment.environmentId === activeProject.environmentId
          ? activeProject
          : allProjects.find(
              (p) =>
                p.environmentId === environment.environmentId && isScratchProject(p, scratchRoot),
            );
      pushEnvironment(environment.environmentId, scratchProject?.id ?? null);
    }
  } else {
    // Keep the source even if its catalog entry is gone. Every paired machine
    // remains visible; missing registrations lead to destination-only setup.
    pushEnvironment(activeProject.environmentId, activeProject.id);
    for (const environment of environments) {
      if (environment.environmentId === activeProject.environmentId) continue;
      const project = freshThreadProject(activeProject, allProjects, environment.environmentId);
      if (draft || project) pushEnvironment(environment.environmentId, project?.id ?? null);
    }
  }
  envs.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return envs;
}

import {
  composerDraftHasUserContent,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "./composerDraftStore";

type DraftSource = {
  readonly draftThreadsByThreadKey: Readonly<Record<string, DraftSessionState>>;
  readonly draftsByThreadKey: Readonly<Record<string, ComposerThreadDraftState>>;
};

/**
 * Includes invested, unmapped sessions, sessions with a terminal and the open
 * empty session, never promoted ones.
 */
export function selectSidebarDraftSessionKeys(
  source: DraftSource,
  input: {
    readonly routeDraftId: string | null;
    readonly scopedProjectKeys: ReadonlySet<string> | null;
    readonly excludedProjectKeys?: ReadonlySet<string> | undefined;
    readonly expanded?: boolean | undefined;
    // Keyed `${environmentId}:${threadId}`, as useDraftTerminalLabels returns them.
    readonly terminalLabels?: ReadonlyMap<string, string> | undefined;
  },
) {
  return Object.entries(source.draftThreadsByThreadKey)
    .filter(([key, session]) => {
      if (session.promotedTo != null) return false;
      const projectKey = `${session.environmentId}:${session.projectId}`;
      if (input.scopedProjectKeys !== null && !input.scopedProjectKeys.has(projectKey))
        return false;
      if (input.excludedProjectKeys?.has(projectKey)) return false;
      if (key === input.routeDraftId) return true;
      return (
        input.expanded !== false &&
        (input.terminalLabels?.has(`${session.environmentId}:${session.threadId}`) === true ||
          composerDraftHasUserContent(source.draftsByThreadKey[key]))
      );
    })
    .sort(([, left], [, right]) => right.createdAt.localeCompare(left.createdAt))
    .map(([key]) => key);
}

/** Stable counts let the sidebar subscribe without following each keystroke. */
export function countSidebarDraftSessions(
  source: DraftSource,
  input: {
    readonly routeDraftId: string | null;
    readonly scopedProjectKeys: ReadonlySet<string> | null;
    readonly terminalLabels?: ReadonlyMap<string, string> | undefined;
  },
) {
  const counts = new Map<string, number>();
  for (const key of selectSidebarDraftSessionKeys(source, input)) {
    const session = source.draftThreadsByThreadKey[key]!;
    const projectKey = `${session.environmentId}:${session.projectId}`;
    counts.set(projectKey, (counts.get(projectKey) ?? 0) + 1);
  }
  return counts;
}

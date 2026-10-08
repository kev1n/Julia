// Regression at the actual New Thread action for an unavailable source.
// Runs the sidebar/keyboard action, real New Thread handler, real settings
// resolver, real t3.json reader, and real environment query/RPC machinery.
// React subscriptions/router and server sessions are isolated fixtures.
import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type OptimisticProjectFile,
  createProjectEnvironmentAtoms,
} from "@t3tools/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

const fixture = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  settings: new Map<EnvironmentId, { settings: ServerSettings }>(),
  registry: null as unknown as AtomRegistry.AtomRegistry,
  runtime: null as unknown as Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry>,
  states: new Map<EnvironmentId, SubscriptionRef.SubscriptionRef<SupervisorConnectionState>>(),
  projectEnvironment: null as unknown as Pick<
    ReturnType<typeof createProjectEnvironmentAtoms>,
    "readFile" | "optimisticFile"
  >,
  route: {
    state: { location: { href: "/build-mac/existing" }, matches: [{ params: {} }] },
    navigate: vi.fn(async (request: { params: { draftId: string } }) => {
      fixture.route.state.location.href = `/draft/${request.params.draftId}`;
    }),
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: <T>(f: T) => f,
  useMemo: <T>(f: () => T) => f(),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => fixture.settings,
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => fixture.route,
  useParams: () => null,
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../state/entities", () => ({
  readProjects: () => fixture.projects,
  readProject: (ref: { environmentId: string; projectId: string }) =>
    fixture.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    ) ?? null,
  readThreadShell: () => null,
  readThreadShells: () => [],
  useProjects: () => fixture.projects,
  useThreadShell: () => null,
}));
// New-thread reads the configs from the registry at call time.
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(() => fixture.settings) };
});
vi.mock("./useSettings", () => ({
  getClientSettings: () => ({
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "",
  useUiStateStore: () => [],
}));
vi.mock("~/connection/runtime", () => ({
  get connectionAtomRuntime() {
    return fixture.runtime;
  },
}));
vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return fixture.registry;
  },
}));
vi.mock("~/state/projects", () => ({
  get projectEnvironment() {
    return fixture.projectEnvironment;
  },
}));
vi.mock("~/state/filesystem", () => ({ useFilesystemReadAccess: () => ({ allowed: true }) }));
// Upstream's handler reads project files only on machines that are connected now.
vi.mock("../state/presentation", async () => {
  const { Atom: ReactivityAtom } = await import("effect/reactivity");
  const { runSync } = await import("effect/Effect");
  const { get } = await import("effect/SubscriptionRef");
  return {
    environmentSummaries: {
      get connectedEnvironmentIdsAtom() {
        const connected = [...fixture.states.entries()].flatMap(([id, state]) =>
          runSync(get(state)).phase === "connected" ? [id] : [],
        );
        return ReactivityAtom.make(connected);
      },
    },
  };
});
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => null }));
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));

import { useNewThreadHandler } from "./useHandleNewThread";
import { readT3ProjectFile } from "../lib/t3ProjectFileDefaults";
import { getProjectFileQueryAtom } from "../components/files/projectFilesQueryState";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";

const build-mac = EnvironmentId.make("build-mac");
const mac-a = EnvironmentId.make("mac-a");
const project1 = ProjectId.make("t3code-build-mac");
const project0 = ProjectId.make("t3code-mac-a");
const sourceRef = scopeProjectRef(build-mac, project1);
const destinationRef = scopeProjectRef(mac-a, project0);
const sourceRoot = "/fixtures/build-mac/t3code";
const repo = {
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/owner/t3code.git",
  },
  canonicalKey: "github.com/owner/t3code",
  name: "t3code",
  rootPath: sourceRoot,
};
const lostTransport = new ConnectionTransientError({
  reason: "transport",
  detail: "isolated simulated 502",
});

const setup = Effect.fn("OfflineNewThreadRepro.setup")(function* (
  phase: SupervisorConnectionState["phase"],
  envMode: "local" | "worktree" | null = null,
  suspendSourceRead = false,
) {
  fixture.projects = [
    {
      id: project1,
      environmentId: build-mac,
      title: "t3code",
      workspaceRoot: sourceRoot,
      repositoryIdentity: repo,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-08T03:00:00.000Z",
      updatedAt: "2026-10-08T03:00:00.000Z",
    },
    {
      id: project0,
      environmentId: mac-a,
      title: "t3code",
      workspaceRoot: "/fixtures/mac-a/t3code",
      repositoryIdentity: { ...repo, rootPath: "/fixtures/mac-a/t3code" },
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-08T03:00:00.000Z",
      updatedAt: "2026-10-08T03:00:00.000Z",
    },
  ];
  fixture.settings = new Map(
    [build-mac, mac-a].map((id) => [
      id,
      {
        settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: envMode },
      },
    ]),
  );
  fixture.route.state.location.href = "/build-mac/existing";
  fixture.route.navigate.mockClear();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  fixture.registry = AtomRegistry.make();
  const sourceReadEntered = yield* Deferred.make<void>();
  const rpcRead = vi.fn((input: { cwd: string }) =>
    suspendSourceRead && input.cwd === sourceRoot
      ? Deferred.succeed(sourceReadEntered, undefined).pipe(Effect.andThen(Effect.never))
      : Effect.succeed({
          relativePath: "t3.json",
          contents: '{"defaultThreadEnvMode":"worktree"}',
          byteLength: 35,
          truncated: false,
        }),
  );
  const states = new Map<
    EnvironmentId,
    SubscriptionRef.SubscriptionRef<SupervisorConnectionState>
  >();
  const sessions = new Map<
    EnvironmentId,
    SubscriptionRef.SubscriptionRef<Option.Option<RpcSession>>
  >();
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  const sessionFixture = {
    client: { [WS_METHODS.projectsReadFile]: rpcRead },
  } as unknown as RpcSession;
  for (const id of [build-mac, mac-a]) {
    const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: id === build-mac ? phase : "connected",
      attempt: 1,
      generation: 1,
      lastFailure: id === build-mac && phase !== "connected" ? lostTransport : null,
    } satisfies SupervisorConnectionState);
    const session = yield* SubscriptionRef.make(
      id === mac-a || phase === "connected"
        ? Option.some(sessionFixture)
        : Option.none<RpcSession>(),
    );
    states.set(id, state);
    sessions.set(id, session);
    supervisors.set(
      id,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId: id,
          label: id,
          httpBaseUrl: `https://${id}.example.test`,
          wsBaseUrl: `wss://${id}.example.test`,
        }),
        state,
        session,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }
  // Only the real query machinery's environment-routing surface is supplied.
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (id, effect) =>
    Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisors.get(id)!,
    );
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    id,
    stream,
  ) =>
    Stream.provideService(
      stream,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisors.get(id)!,
    );
  const service = {
    run,
    followStream,
    stateChanges: (id: EnvironmentId) => SubscriptionRef.changes(states.get(id)!),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, service));
  fixture.runtime = runtime;
  fixture.states = states;
  fixture.projectEnvironment = {
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "offline-repro:readFile",
      tag: WS_METHODS.projectsReadFile,
    }),
    optimisticFile: Atom.family(() => Atom.make<OptimisticProjectFile | null>(null)),
  };
  return { states, sessions, rpcRead, sessionFixture, sourceReadEntered };
});

async function open(ref = sourceRef, options?: { envMode: "worktree" }): Promise<void> {
  const handleNewThread = useNewThreadHandler();
  await (options
    ? handleNewThread(ref, options)
    : startNewThreadFromContext({
        activeThread: { environmentId: ref.environmentId, projectId: ref.projectId },
        activeDraftThread: null,
        defaultProjectRef: destinationRef,
        handleNewThread,
      }));
}

afterEach(() => fixture.registry?.dispose());

describe("offline source New Thread", () => {
  it.effect.each([
    { phase: "backoff" as const, reuseEmptyDraft: false },
    { phase: "connecting" as const, reuseEmptyDraft: false },
    { phase: "backoff" as const, reuseEmptyDraft: true },
  ])(
    "opens before recovery: build-mac=$phase, reusable=$reuseEmptyDraft, mac-a=healthy",
    ({ phase, reuseEmptyDraft }) =>
      Effect.gen(function* () {
        const harness = yield* setup(phase);
        if (reuseEmptyDraft) {
          useComposerDraftStore
            .getState()
            .setLogicalProjectDraftThreadId(
              repo.canonicalKey,
              sourceRef,
              DraftId.make("empty-existing"),
              {
                threadId: ThreadId.make("empty-existing-thread"),
                envMode: "local",
              },
            );
        }
        const pending = open();
        // A healthy destination answers its own file query before the source is recovered.
        expect(
          yield* Effect.promise(() => readT3ProjectFile(mac-a, "/fixtures/mac-a/t3code")),
        ).toEqual({
          defaultThreadEnvMode: "worktree",
        });
        const routeBeforeRecovery = fixture.route.state.location.href;
        const draftBeforeRecovery = useComposerDraftStore
          .getState()
          .getDraftSessionByLogicalProjectKey(repo.canonicalKey);
        // Recovery unblocks the exact pending click, proving the dependency.
        yield* SubscriptionRef.set(
          harness.sessions.get(build-mac)!,
          Option.some(harness.sessionFixture),
        );
        yield* SubscriptionRef.set<SupervisorConnectionState>(harness.states.get(build-mac)!, {
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 2,
          generation: 2,
        });
        yield* Effect.promise(() => pending);
        expect(fixture.route.state.location.href).toMatch(/^\/draft\//);
        expect(
          useComposerDraftStore.getState().getDraftSessionByLogicalProjectKey(repo.canonicalKey),
        ).not.toBeNull();
        // Regression expectation: it should already have opened before recovery.
        expect(routeBeforeRecovery).toMatch(/^\/draft\//);
        expect(draftBeforeRecovery).not.toBeNull();
      }),
  );
  it.effect("cached t3.json does not make a fresh draft depend on recovery", () =>
    Effect.gen(function* () {
      const harness = yield* setup("connected");
      expect(yield* Effect.promise(() => readT3ProjectFile(build-mac, sourceRoot))).toEqual({
        defaultThreadEnvMode: "worktree",
      });
      yield* SubscriptionRef.set(harness.sessions.get(build-mac)!, Option.none());
      yield* SubscriptionRef.set<SupervisorConnectionState>(harness.states.get(build-mac)!, {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "backoff",
        attempt: 2,
        generation: 1,
        lastFailure: lostTransport,
      });
      // Observe the source query suspended on reconnection before clicking.
      // A cached value read before this propagation can still open successfully.
      const releaseCachedFile = fixture.registry.mount(
        getProjectFileQueryAtom(build-mac, sourceRoot, "t3.json"),
      );
      yield* AtomRegistry.toStream(
        fixture.registry,
        getProjectFileQueryAtom(build-mac, sourceRoot, "t3.json"),
      ).pipe(
        Stream.filter((result) => result.waiting),
        Stream.runHead,
      );
      const pending = open();
      expect(
        yield* Effect.promise(() => readT3ProjectFile(mac-a, "/fixtures/mac-a/t3code")),
      ).toEqual({
        defaultThreadEnvMode: "worktree",
      });
      const routeBeforeRecovery = fixture.route.state.location.href;
      yield* SubscriptionRef.set(harness.sessions.get(build-mac)!, Option.some(harness.sessionFixture));
      yield* SubscriptionRef.set<SupervisorConnectionState>(harness.states.get(build-mac)!, {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 2,
        generation: 2,
      });
      yield* Effect.promise(() => pending);
      releaseCachedFile();
      expect(fixture.route.state.location.href).toMatch(/^\/draft\//);
      expect(routeBeforeRecovery).toMatch(/^\/draft\//);
    }),
  );
  it.effect.each(["backoff", "connecting", "connected"] as const)(
    "connection lost during t3.json read opens without source recovery ($phase)",
    (phase) =>
      Effect.gen(function* () {
        const harness = yield* setup("connected", null, true);
        const pending = open();
        yield* Deferred.await(harness.sourceReadEntered);
        yield* SubscriptionRef.set(harness.sessions.get(build-mac)!, Option.none());
        yield* SubscriptionRef.update(harness.states.get(build-mac)!, (state) => ({ ...state, phase }));
        yield* Effect.promise(() => pending);
        expect(fixture.route.state.location.href).toMatch(/^\/draft\//);
        expect(Option.isNone(yield* SubscriptionRef.get(harness.sessions.get(build-mac)!))).toBe(true);
      }),
  );
  it.effect("connected source retains its project-file workspace default", () =>
    Effect.gen(function* () {
      yield* setup("connected");
      yield* Effect.promise(() => open());
      expect(
        useComposerDraftStore.getState().getDraftSessionByLogicalProjectKey(repo.canonicalKey)
          ?.envMode,
      ).toBe("worktree");
    }),
  );
  it.effect("terminal offline state returns fallback and opens the draft", () =>
    Effect.gen(function* () {
      yield* setup("offline");
      yield* Effect.promise(() => open());
      expect(fixture.route.state.location.href).toMatch(/^\/draft\//);
    }),
  );
  it.effect("explicit workspace mode bypasses a reconnecting source", () =>
    Effect.gen(function* () {
      yield* setup("backoff");
      yield* Effect.promise(() => open(sourceRef, { envMode: "worktree" }));
      expect(fixture.route.state.location.href).toMatch(/^\/draft\//);
    }),
  );
  it.effect("configured environment workspace mode bypasses a reconnecting source", () =>
    Effect.gen(function* () {
      yield* setup("backoff", "worktree");
      yield* Effect.promise(() => open());
      expect(fixture.route.state.location.href).toMatch(/^\/draft\//);
    }),
  );
  it.effect("choosing the healthy registered project at entry succeeds independently", () =>
    Effect.gen(function* () {
      yield* setup("backoff");
      yield* Effect.promise(() => open(destinationRef));
      expect(fixture.route.state.location.href).toMatch(/^\/draft\//);
    }),
  );
});

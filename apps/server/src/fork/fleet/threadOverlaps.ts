// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 cache keys match existing fleet Node infrastructure.
/** Fork (Owner): one cached repository-level judgment, shared by clients and MCP. */
import * as NodeCrypto from "node:crypto";
import { ForkFleetOverlapsResult, type ForkFleetOverlap } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import type { FleetRelationsOutput } from "@t3tools/provider-core/server/fleetRelationsPrompt";
import { fleetRequest } from "./config.ts";
import { isActive } from "./fleetIndex.ts";
import type { FleetThread } from "./model.ts";
import { fleetConfig, localSnapshot } from "./publisher.ts";
import { loadView } from "./view.ts";

export class FleetSuggestions extends Context.Service<
  FleetSuggestions,
  {
    readonly read: (
      threadId: string,
      options?: { readonly wait?: boolean; readonly environmentId?: string },
    ) => Effect.Effect<ForkFleetOverlapsResult>;
  }
>()("t3/fork/fleet/threadOverlaps/FleetSuggestions") {}

const decodeResult = Schema.decodeUnknownEffect(ForkFleetOverlapsResult);
const encodeContext = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const idOf = (thread: FleetThread) => `${thread.environmentId}/${thread.threadId}`;
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
/** Preserve the original goal and latest steering/findings, rather than just a prefix. */
const compact = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, 400)}\n…\n${text.slice(-(limit - 403))}`;
const evidence = (thread: FleetThread) => ({
  threadId: idOf(thread),
  title: thread.title.slice(0, 120),
  context: compact(thread.workContext ?? "", 1800),
  declaredNotes: thread.intents
    .flatMap((intent) => (intent.note ? [intent.note.slice(0, 120)] : []))
    .slice(0, 2),
});

type Cached = {
  key: string;
  status: ForkFleetOverlapsResult["status"];
  suggestions: (typeof FleetRelationsOutput.Type)["suggestions"];
  evidence: ReadonlyMap<string, string>;
  attemptedAt: number;
  completed: Deferred.Deferred<void>;
};

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const scope = yield* Scope.Scope;
  const limiter = yield* Semaphore.make(1);
  const cache = new Map<string, Cached>();
  let attempts: number[] = [];

  const read = Effect.fn("fork.fleet.suggestions.read")(function* (
    threadId: string,
    options?: { readonly wait?: boolean; readonly environmentId?: string },
  ) {
    const config = fleetConfig();
    const local = localSnapshot();
    if (config === null || local === null) return { overlaps: [], status: "unavailable" as const };
    if (!config.hub) {
      return yield* Effect.tryPromise(() =>
        fleetRequest(config, `${config.hubUrl}/fork/fleet/hub/suggestions`, {
          environmentId: local.environmentId,
          threadId,
        }),
      ).pipe(
        Effect.flatMap(decodeResult),
        Effect.orElseSucceed(() => ({ overlaps: [], status: "unavailable" as const })),
      );
    }
    const view = yield* Effect.tryPromise(() => loadView(config, local)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (view === null) return { overlaps: [], status: "unavailable" as const };
    const targetEnvironment = options?.environmentId ?? local.environmentId;
    const me = view.entries
      .find((entry) => entry.snapshot.environmentId === targetEnvironment)
      ?.snapshot.threads.find((thread) => thread.threadId === threadId);
    if (me === undefined || !isActive(me) || me.repoKey === null)
      return { overlaps: [], status: "ready" as const };
    if (!me.workContext?.trim()) return { overlaps: [], status: "unavailable" as const };
    const relevant = view.entries.flatMap((entry) =>
      entry.snapshot.threads
        .filter(
          (other) =>
            isActive(other) &&
            other.repoKey === me.repoKey &&
            (other.lifecycle === "running" ||
              (other.lastActivityAt !== null && view.now - other.lastActivityAt < 86_400_000)),
        )
        .map((thread) => ({
          thread,
          snapshot: entry.snapshot,
          fresh:
            view.coverage.find((row) => row.environmentId === entry.snapshot.environmentId)
              ?.status === "fresh",
        })),
    );
    const candidates = relevant
      .filter((other) => other.fresh && !!other.thread.workContext?.trim())
      .sort((a, b) => (b.thread.lastActivityAt ?? 0) - (a.thread.lastActivityAt ?? 0))
      .slice(0, 24)
      .sort((a, b) => idOf(a.thread).localeCompare(idOf(b.thread)));
    const partial = candidates.length < relevant.length || view.hub === "unreachable";
    const coverage = partial ? { partial: true } : {};
    if (!candidates.some(({ thread }) => idOf(thread) === idOf(me)))
      return { overlaps: [], status: "unavailable" as const };
    if (candidates.length < 2)
      return {
        overlaps: [],
        status: partial ? ("unavailable" as const) : ("ready" as const),
        ...coverage,
      };
    const threadEvidence = candidates.map(({ thread }) => evidence(thread));
    const context = yield* encodeContext({ threads: threadEvidence }).pipe(Effect.orDie);
    // Hard input cap (including escaping), even if a malformed snapshot contains huge identifiers.
    if (context.length > 64_000) return { overlaps: [], status: "unavailable" as const };
    const fingerprints = new Map<string, string>();
    for (const data of threadEvidence)
      fingerprints.set(data.threadId, hash(yield* encodeContext(data).pipe(Effect.orDie)));
    const key = hash(context);
    const now = yield* Clock.currentTimeMillis;
    const previous = cache.get(me.repoKey);
    const answer = Effect.fn("threadOverlaps.answer")(function* (
      cached: Cached,
      status = cached.status,
    ) {
      if (options?.wait && cached.key === key && cached.status === "checking") {
        yield* Deferred.await(cached.completed);
        status = cached.status;
      }
      const overlaps = cached.suggestions.flatMap((suggestion): ForkFleetOverlap[] => {
        const ids = [suggestion.aId, suggestion.bId];
        if (
          !ids.includes(idOf(me)) ||
          ids.some((id) => cached.evidence.get(id) !== fingerprints.get(id))
        )
          return [];
        const other = candidates.find(
          ({ thread }) =>
            idOf(thread) === (suggestion.aId === idOf(me) ? suggestion.bId : suggestion.aId),
        );
        if (!other) return [];
        return [
          {
            environmentId: other.thread.environmentId,
            threadId: other.thread.threadId,
            title: other.thread.title,
            machine: other.snapshot.label,
            lifecycle: other.thread.lifecycle === "running" ? "running" : "idle",
            branch: other.thread.branch,
            kind: suggestion.kind,
            reason: suggestion.reason,
            url: `${other.snapshot.baseUrl}/${other.thread.environmentId}/${other.thread.threadId}`,
          },
        ];
      });
      return { overlaps, status, ...coverage };
    });
    if (
      previous?.key === key &&
      (previous.status !== "unavailable" || now - previous.attemptedAt < 300_000)
    )
      return yield* answer(previous);
    // New activity in an unrelated chat does not erase valid pair reasons. Changed goals do.
    if (previous && (previous.status === "checking" || now - previous.attemptedAt < 300_000))
      return yield* answer(previous, "checking");
    // The hub alone judges: at most three attempts per ten minutes across the entire fleet.
    attempts = attempts.filter((at) => now - at < 600_000);
    if (attempts.length >= 3)
      return previous
        ? yield* answer(previous, "checking")
        : { overlaps: [], status: "checking" as const };
    attempts.push(now);
    const row: Cached = {
      key,
      status: "checking",
      suggestions: [],
      evidence: fingerprints,
      attemptedAt: now,
      completed: yield* Deferred.make<void>(),
    };
    cache.set(me.repoKey, row);
    if (cache.size > 100) {
      const removable = [...cache].find(
        ([repo, value]) => repo !== me.repoKey && value.status !== "checking",
      );
      if (removable) cache.delete(removable[0]);
    }
    const judge = Effect.gen(function* () {
      const instances = yield* registry.listInstances;
      for (const model of ["gpt-6-luna", "claude-haiku-5-5"]) {
        for (const instance of instances) {
          if (
            !instance.enabled ||
            (model.startsWith("gpt")
              ? instance.driverKind !== "codex"
              : instance.driverKind !== "claudeAgent")
          )
            continue;
          const snapshot = yield* instance.snapshot.getSnapshot;
          if (
            !snapshot.installed ||
            snapshot.availability === "unavailable" ||
            !snapshot.models.some((candidate) => candidate.slug === model)
          )
            continue;
          const result = yield* instance.textGeneration
            .generateFleetRelations({
              cwd: config.userdataDir,
              context,
              modelSelection: createModelSelection(instance.instanceId, model, [
                { id: model.startsWith("gpt") ? "reasoningEffort" : "effort", value: "low" },
              ]),
            })
            .pipe(Effect.timeoutOption("90 seconds"));
          if (result._tag === "None") return false;
          const seen = new Set<string>();
          row.suggestions = result.value.suggestions.flatMap((suggestion) => {
            if (
              suggestion.aId === suggestion.bId ||
              !fingerprints.has(suggestion.aId) ||
              !fingerprints.has(suggestion.bId) ||
              !suggestion.reason.trim()
            )
              return [];
            const pair = [suggestion.aId, suggestion.bId].sort().join("|");
            if (seen.has(pair)) return [];
            seen.add(pair);
            return [{ ...suggestion, reason: suggestion.reason.trim().slice(0, 500) }];
          });
          return true;
        }
      }
      return false;
    }).pipe(
      Effect.catchCause(() => Effect.succeed(false)),
      Effect.tap((ok) =>
        Effect.sync(() => {
          row.status = ok ? "ready" : "unavailable";
        }),
      ),
      Effect.ensuring(Deferred.succeed(row.completed, undefined)),
    );
    yield* Effect.forkIn(limiter.withPermits(1)(judge), scope);
    return yield* answer(row);
  });
  return FleetSuggestions.of({ read });
});
export const layer = Layer.effect(FleetSuggestions, make);

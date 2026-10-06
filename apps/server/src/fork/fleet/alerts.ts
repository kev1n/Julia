// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork (Owner): automatic overlap alerts, decided on the hub from its index.
 * Pure, so the rule can be tested without servers.
 *
 * - Interrupt: both threads are running (a turn is in flight), both machines
 *   are fresh, and both write the exact same file (observed in the checkout,
 *   or declared with write access on that path). Delivered at once by
 *   steering the running turn.
 * - Every other overlap the index reports is a passive note, delivered at the
 *   recipient's next turn (notices.ts).
 * - Each directed pair (recipient, other thread) is told once per file set:
 *   again only when the set of overlapping paths changes, or when the same
 *   set escalates from passive to interrupt. When an overlap ends, any
 *   undelivered note is withdrawn and the pair may be told again later.
 * - Notes only: nothing is stopped, merged or redirected.
 */
import * as NodeCrypto from "node:crypto";

import { type FleetEvidence, type FleetOverlapPath, findOverlaps, isActive } from "./fleetIndex.ts";
import { acmePathMeaning } from "./acmePaths.ts";
import type { FleetEnvironmentEntry, FleetThread } from "./model.ts";

export type AlertLevel = "interrupt" | "passive";

export interface AlertPairState {
  readonly signature: string;
  readonly level: AlertLevel;
  /** False until the recipient's server accepted the note. */
  readonly delivered: boolean;
}

/** Keyed by `pairKey(recipient, other)`. */
export type AlertState = Readonly<Record<string, AlertPairState>>;

export interface AlertParty {
  readonly thread: FleetThread;
  readonly label: string;
  readonly baseUrl: string;
  readonly fresh: boolean;
}

export type AlertDecision =
  | {
      readonly action: "notify";
      readonly key: string;
      /** Stable per pair, file set and level: the delivery's idempotency key. */
      readonly noticeId: string;
      readonly level: AlertLevel;
      readonly reason: "new" | "changed" | "escalated" | "retry";
      readonly signature: string;
      readonly recipient: AlertParty;
      readonly other: AlertParty;
      /** Evidence from the recipient's side as `mine`. */
      readonly paths: ReadonlyArray<FleetOverlapPath>;
    }
  | {
      readonly action: "defer";
      readonly key: string;
      readonly level: AlertLevel;
      readonly signature: string;
      readonly recipient: AlertParty;
      readonly other: AlertParty;
      readonly paths: ReadonlyArray<FleetOverlapPath>;
    }
  | {
      readonly action: "withdraw";
      readonly key: string;
      readonly previous: AlertPairState;
      readonly recipient: { readonly environmentId: string; readonly threadId: string };
      readonly baseUrl: string | null;
    };

export const pairKey = (
  recipient: Pick<FleetThread, "environmentId" | "threadId">,
  other: Pick<FleetThread, "environmentId" | "threadId">,
) => `${recipient.environmentId}/${recipient.threadId}>${other.environmentId}/${other.threadId}`;

const parseKey = (key: string) => {
  const [recipient = "", other = ""] = key.split(">");
  const split = (side: string) => {
    const slash = side.indexOf("/");
    return { environmentId: side.slice(0, slash), threadId: side.slice(slash + 1) };
  };
  return { recipient: split(recipient), other: split(other) };
};

/** Writes this exact path (not through a directory key). */
const writesExactly = (path: string, evidence: ReadonlyArray<FleetEvidence>) =>
  evidence.some(
    (item) =>
      item.source === "observed" ||
      (item.access === "write" && item.key === path && !item.key.endsWith("/")),
  );

export function levelOf(
  recipient: AlertParty,
  other: AlertParty,
  paths: ReadonlyArray<FleetOverlapPath>,
): AlertLevel {
  const bothWorking =
    recipient.fresh &&
    other.fresh &&
    recipient.thread.lifecycle === "running" &&
    other.thread.lifecycle === "running";
  const sameFile = paths.some(
    (path) => writesExactly(path.path, path.mine) && writesExactly(path.path, path.theirs),
  );
  return bothWorking && sameFile ? "interrupt" : "passive";
}

export const signatureOf = (paths: ReadonlyArray<FleetOverlapPath>) =>
  paths
    .map((path) => `${path.path}:${path.conflict}`)
    .sort()
    .join("\n");

/** A stable id for a note: pair, file set and level. */
export const noticeIdOf = (key: string, signature: string, level: AlertLevel) =>
  NodeCrypto.createHash("sha256").update(`${key}|${signature}|${level}`).digest("hex").slice(0, 24);

const swap = (path: FleetOverlapPath): FleetOverlapPath => ({
  ...path,
  mine: path.theirs,
  theirs: path.mine,
});

/**
 * Decide alerts after `environmentId` published: its active threads are
 * looked up in the index (the same lookup t3_who_else uses), each overlap
 * yields one decision per direction, and pairs involving its threads that no
 * longer overlap are withdrawn.
 */
export function decideAlerts(input: {
  readonly environmentId: string;
  readonly entries: ReadonlyArray<FleetEnvironmentEntry>;
  readonly now: number;
  readonly staleAfterMs: number;
  readonly state: AlertState;
}): { readonly decisions: ReadonlyArray<AlertDecision>; readonly state: AlertState } {
  const { entries, now, staleAfterMs } = input;
  const byEnvironment = new Map(entries.map((entry) => [entry.snapshot.environmentId, entry]));
  const partyOf = (thread: FleetThread): AlertParty => {
    const entry = byEnvironment.get(thread.environmentId)!;
    return {
      thread,
      label: entry.snapshot.label,
      baseUrl: entry.snapshot.baseUrl,
      fresh: now - entry.receivedAt <= staleAfterMs,
    };
  };
  const publishing = byEnvironment.get(input.environmentId);
  const current = new Map<
    string,
    { recipient: AlertParty; other: AlertParty; paths: ReadonlyArray<FleetOverlapPath> }
  >();
  for (const me of publishing?.snapshot.threads ?? []) {
    if (!isActive(me)) continue;
    const myCheckout = publishing!.snapshot.checkouts.find(
      (checkout) => checkout.key === me.checkoutKey,
    );
    for (const overlap of findOverlaps({ me, myCheckout, entries, now, staleAfterMs })) {
      if (overlap.paths.length === 0) continue;
      const mine = partyOf(me);
      const theirs = partyOf(overlap.thread);
      current.set(pairKey(me, overlap.thread), {
        recipient: mine,
        other: theirs,
        paths: overlap.paths,
      });
      current.set(pairKey(overlap.thread, me), {
        recipient: theirs,
        other: mine,
        paths: overlap.paths.map(swap),
      });
    }
  }
  const decisions: AlertDecision[] = [];
  const state: Record<string, AlertPairState> = { ...input.state };
  for (const [key, { recipient, other, paths }] of current) {
    const signature = signatureOf(paths);
    const level = levelOf(recipient, other, paths);
    const previous = state[key];
    const reason =
      previous === undefined
        ? "new"
        : previous.signature !== signature
          ? "changed"
          : level === "interrupt" && previous.level === "passive"
            ? "escalated"
            : previous.delivered
              ? null
              : "retry";
    if (reason === null) continue;
    // A note for the same file set never steps down from interrupt to passive.
    const effective = reason === "retry" ? previous!.level : level;
    if (!recipient.fresh) {
      if (reason !== "retry") {
        state[key] = { signature, level: effective, delivered: false };
        decisions.push({
          action: "defer",
          key,
          level: effective,
          signature,
          recipient,
          other,
          paths,
        });
      }
      continue;
    }
    decisions.push({
      action: "notify",
      key,
      noticeId: noticeIdOf(key, signature, effective),
      level: effective,
      reason,
      signature,
      recipient,
      other,
      paths,
    });
    // Delivery marks it delivered (alertHub.ts); until then the next look retries.
    state[key] = { signature, level: effective, delivered: false };
  }
  for (const [key, previous] of Object.entries(input.state)) {
    if (current.has(key)) continue;
    const { recipient, other } = parseKey(key);
    if (
      recipient.environmentId !== input.environmentId &&
      other.environmentId !== input.environmentId
    ) {
      continue;
    }
    delete state[key];
    decisions.push({
      action: "withdraw",
      key,
      previous,
      recipient,
      baseUrl: byEnvironment.get(recipient.environmentId)?.snapshot.baseUrl ?? null,
    });
  }
  return { decisions, state };
}

const ago = (ms: number) =>
  ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

function evidenceText(evidence: ReadonlyArray<FleetEvidence>): string {
  return evidence
    .map((item) =>
      item.source === "observed"
        ? `observed (${item.kind}, ${item.change})`
        : `declared ${item.access}${item.key.endsWith("/") ? ` on ${item.key}` : ""}`,
    )
    .join(" + ");
}

/** The note the recipient's agent reads. */
export function noteText(input: {
  readonly level: AlertLevel;
  readonly recipient: AlertParty;
  readonly other: AlertParty;
  readonly paths: ReadonlyArray<FleetOverlapPath>;
  readonly entries: ReadonlyArray<FleetEnvironmentEntry>;
  readonly now: number;
  readonly staleAfterMs: number;
  readonly hubLabel: string;
}): string {
  const { other } = input;
  const thread = other.thread;
  const files = input.paths.map((path) => {
    const meaning = acmePathMeaning(thread.repoKey, path.path);
    const area = meaning?.sku
      ? ` (SKU ${meaning.sku})`
      : meaning?.provider
        ? ` (provider ${meaning.provider})`
        : "";
    return `- ${path.path}${area}: you ${evidenceText(path.mine)}; them ${evidenceText(path.theirs)}`;
  });
  const coverage = input.entries
    .map((entry) => {
      const age = input.now - entry.receivedAt;
      return `${entry.snapshot.label} (${age > input.staleAfterMs ? "stale" : "fresh"}, last heartbeat ${ago(age)} ago)`;
    })
    .join(", ");
  const head =
    input.level === "interrupt"
      ? "[Fleet overlap alert] Another chat is working right now and editing the same file(s) as this chat."
      : "[Fleet overlap note] Another chat touches the same file(s) as this chat. This note waited for your next turn.";
  return [
    head,
    "",
    `Other chat: "${thread.title}" on ${other.label} (${thread.lifecycle}${thread.branch ? `, branch ${thread.branch}` : ""})`,
    `Open it: ${other.baseUrl}/${thread.environmentId}/${thread.threadId}`,
    "Files (declared = published with t3_work_publish; observed = changed in its checkout):",
    ...files,
    "",
    `Fleet data as of ${new Date(input.now).toISOString()} from the index on ${input.hubLabel}; covers ${coverage}.`,
    `This is a note only: nothing was stopped, merged or redirected. To coordinate, read or message that chat with t3_fleet_thread_read / t3_fleet_thread_send (environmentId ${thread.environmentId}, threadId ${thread.threadId}), or call t3_who_else.`,
  ].join("\n");
}

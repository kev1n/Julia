// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork (Owner): the hub runs the overlap-alert rule (alerts.ts) after each
 * accepted publish and delivers notes to the servers that own the threads
 * (POST <owner>/fork/fleet/notice, handled by notices.ts).
 *
 * Runs are serialized, so two publishes never decide on the same state at
 * once. Which pairs were told what survives a hub restart
 * (`fork-fleet-alerts-state.json`), and every decision is appended to
 * `logs/fork-fleet-alerts.jsonl` on the hub for later review of real
 * overlap data. A pair whose overlap is unchanged produces no decision.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type AlertDecision, type AlertState, decideAlerts, noteText } from "./alerts.ts";
import { STALE_AFTER_MS, fleetRequest, type FleetConfig } from "./config.ts";
import type { FleetIndex } from "./model.ts";
import type { NoticeOutcome, NoticeRequest } from "./notices.ts";

let state: AlertState | null = null;
let queue: Promise<void> = Promise.resolve();
/** Environments with an evaluation already queued; it will read the newest index anyway. */
const queued = new Set<string>();

const statePath = (config: FleetConfig) =>
  NodePath.join(config.userdataDir, "fork-fleet-alerts-state.json");

function loadState(config: FleetConfig): AlertState {
  if (state !== null) return state;
  try {
    state = JSON.parse(NodeFS.readFileSync(statePath(config), "utf8")) as AlertState;
  } catch {
    state = {};
  }
  return state;
}

function saveState(config: FleetConfig, next: AlertState) {
  state = next;
  const temporary = `${statePath(config)}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  NodeFS.renameSync(temporary, statePath(config));
}

function log(config: FleetConfig, record: Record<string, unknown>) {
  const directory = NodePath.join(config.userdataDir, "logs");
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.appendFileSync(
    NodePath.join(directory, "fork-fleet-alerts.jsonl"),
    `${JSON.stringify(record)}\n`,
  );
}

const side = (party: Extract<AlertDecision, { action: "notify" }>["recipient"]) => ({
  machine: party.label,
  environmentId: party.thread.environmentId,
  threadId: party.thread.threadId,
  title: party.thread.title,
  lifecycle: party.thread.lifecycle,
  branch: party.thread.branch,
  fresh: party.fresh,
});

async function deliver(config: FleetConfig, baseUrl: string, request: NoticeRequest) {
  const reply = (await fleetRequest(config, `${baseUrl}/fork/fleet/notice`, request)) as {
    readonly outcome: NoticeOutcome;
  };
  return reply.outcome;
}

async function evaluate(config: FleetConfig, index: FleetIndex, environmentId: string) {
  const hubLabel =
    index.environments.find((entry) => entry.snapshot.baseUrl === config.selfUrl)?.snapshot.label ??
    new URL(config.selfUrl).hostname;
  const { decisions, state: next } = decideAlerts({
    environmentId,
    entries: index.environments,
    now: index.asOf,
    staleAfterMs: STALE_AFTER_MS,
    state: loadState(config),
  });
  if (decisions.length === 0) return;
  const coverage = index.environments.map((entry) => ({
    machine: entry.snapshot.label,
    heartbeatAgeMs: index.asOf - entry.receivedAt,
    fresh: index.asOf - entry.receivedAt <= STALE_AFTER_MS,
  }));
  const updated: Record<string, AlertState[string]> = { ...next };
  for (const decision of decisions) {
    const at = new Date().toISOString();
    if (decision.action === "withdraw") {
      let outcome: string;
      try {
        outcome =
          decision.baseUrl === null
            ? "recipient-unknown"
            : await deliver(config, decision.baseUrl, {
                key: decision.key,
                noticeId: "",
                threadId: decision.recipient.threadId,
                level: "withdraw",
              });
      } catch (error) {
        outcome = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      log(config, {
        at,
        decision: "withdraw",
        key: decision.key,
        previous: decision.previous,
        outcome,
      });
      continue;
    }
    const base = {
      at,
      key: decision.key,
      level: decision.level,
      recipient: side(decision.recipient),
      other: side(decision.other),
      paths: decision.paths,
      dataAsOf: new Date(index.asOf).toISOString(),
      coverage,
    };
    if (decision.action === "defer") {
      log(config, { ...base, decision: "defer", why: "recipient's machine is stale" });
      continue;
    }
    const text = noteText({
      level: decision.level,
      recipient: decision.recipient,
      other: decision.other,
      paths: decision.paths,
      entries: index.environments,
      now: index.asOf,
      staleAfterMs: STALE_AFTER_MS,
      hubLabel,
    });
    try {
      const outcome = await deliver(config, decision.recipient.baseUrl, {
        key: decision.key,
        noticeId: decision.noticeId,
        threadId: decision.recipient.thread.threadId,
        level: decision.level,
        text,
      });
      updated[decision.key] = { ...updated[decision.key]!, delivered: true };
      log(config, { ...base, decision: "notify", reason: decision.reason, outcome, text });
    } catch (error) {
      // Left undelivered: the next look at this pair retries with the same notice id.
      log(config, {
        ...base,
        decision: "notify",
        reason: decision.reason,
        outcome: `failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  saveState(config, updated);
}

/** Queue an evaluation after `environmentId`'s snapshot was accepted. Never throws. */
export function scheduleAlerts(
  config: FleetConfig,
  index: () => FleetIndex,
  environmentId: string,
) {
  if (queued.has(environmentId)) return;
  queued.add(environmentId);
  queue = queue
    .then(() => {
      queued.delete(environmentId);
      return evaluate(config, index(), environmentId);
    })
    .catch((error: unknown) => {
      try {
        log(config, { at: new Date().toISOString(), decision: "error", error: String(error) });
      } catch {
        // Logging is best effort; the next publish evaluates again.
      }
    });
}

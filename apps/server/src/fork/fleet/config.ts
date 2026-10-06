// @effect-diagnostics globalFetch:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork (Owner): fleet settings, one file per server,
 * `~/.t3/userdata/fork-fleet.json` (mode 600):
 *
 *   { "hubUrl": "https://mac-a-host.example.ts.net",
 *     "selfUrl": "https://<this host>.example.ts.net",
 *     "secret": "<shared fleet secret>",
 *     "hub": true }            // only on the hub (mac-a)
 *
 * Without the file the fleet is off: the tools say so and nothing is published.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface FleetConfig {
  readonly hubUrl: string;
  readonly selfUrl: string;
  readonly secret: string;
  readonly hub: boolean;
  readonly userdataDir: string;
}

/**
 * Every server republishes its full snapshot and rescans its active checkouts this often (about
 * 36 ms per checkout, ~2% of a core for six). Also the fleet HTTP timeout: an answer older than
 * one heartbeat is superseded anyway.
 */
export const HEARTBEAT_MS = 10_000;
/** Records turn stale after three missed heartbeats (one late beat is not an outage). */
export const STALE_AFTER_MS = 3 * HEARTBEAT_MS;

export function readFleetConfig(userdataDir: string): FleetConfig | null {
  try {
    const raw = JSON.parse(
      NodeFS.readFileSync(NodePath.join(userdataDir, "fork-fleet.json"), "utf8"),
    ) as Partial<FleetConfig>;
    if (!raw.hubUrl || !raw.selfUrl || !raw.secret) return null;
    return {
      hubUrl: raw.hubUrl.replace(/\/$/, ""),
      selfUrl: raw.selfUrl.replace(/\/$/, ""),
      secret: raw.secret,
      hub: raw.hub === true,
      userdataDir,
    };
  } catch {
    return null;
  }
}

/** Constant-time check of `Authorization: Bearer <secret>`. */
export function authorized(config: FleetConfig, header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${config.secret}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
}

export class FleetHttpError extends Error {
  /** True when the request may have been applied (timeout or lost response). */
  readonly ambiguous: boolean;
  constructor(message: string, ambiguous: boolean) {
    super(message);
    this.ambiguous = ambiguous;
  }
}

/** POST/GET JSON to another fleet server. Never retries. */
export async function fleetRequest(
  config: FleetConfig,
  url: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${config.secret}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(HEARTBEAT_MS),
    });
  } catch (cause) {
    // Before a response, a POST may or may not have reached the server.
    throw new FleetHttpError(
      `${new URL(url).host}: ${cause instanceof Error ? cause.message : String(cause)}`,
      body !== undefined,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new FleetHttpError(
      `${new URL(url).host}: HTTP ${response.status} ${text.slice(0, 300)}`,
      false,
    );
  }
  return text === "" ? null : (JSON.parse(text) as unknown);
}

// @effect-diagnostics globalFetch:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: fleet settings in `~/.t3/userdata/fork-fleet.json` (mode 600), with `hubUrl`,
 * `selfUrl`, the shared `secret`, `"hub": true` only on the hub machine, and optional
 * `pathMeanings` (`pathMeanings.ts`). Without the file the fleet is off: the tools say so and
 * nothing is published.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import { parsePathMeanings, type PathMeaningRule } from "./pathMeanings.ts";

export interface FleetConfig {
  readonly hubUrl: string;
  readonly selfUrl: string;
  readonly secret: string;
  readonly hub: boolean;
  readonly userdataDir: string;
  readonly pathMeanings: ReadonlyArray<PathMeaningRule>;
  /** `"mirrorProjects": false` keeps this machine out of project mirroring (`projectMirror.ts`). */
  readonly mirrorProjects: boolean;
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
    ) as Partial<Omit<FleetConfig, "pathMeanings" | "mirrorProjects">> & {
      readonly pathMeanings?: unknown;
      readonly mirrorProjects?: unknown;
    };
    if (!raw.hubUrl || !raw.selfUrl || !raw.secret) return null;
    return {
      hubUrl: raw.hubUrl.replace(/\/$/, ""),
      selfUrl: raw.selfUrl.replace(/\/$/, ""),
      secret: raw.secret,
      hub: raw.hub === true,
      userdataDir,
      pathMeanings: parsePathMeanings(raw.pathMeanings),
      mirrorProjects: raw.mirrorProjects !== false,
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

export class FleetHttpError extends Schema.TaggedError<FleetHttpError>()("FleetHttpError", {
  message: Schema.String,
  /** True when the request may have been applied (timeout or lost response). */
  ambiguous: Schema.Boolean,
}) {}

/** A fleet step that threw; `cause` is what it threw. */
export class FleetOperationError extends Schema.TaggedError<FleetOperationError>()(
  "FleetOperationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
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
    throw new FleetHttpError({
      message: `${new URL(url).host}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ambiguous: body !== undefined,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new FleetHttpError({
      message: `${new URL(url).host}: HTTP ${response.status} ${text.slice(0, 300)}`,
      ambiguous: false,
    });
  }
  return text === "" ? null : (JSON.parse(text) as unknown);
}

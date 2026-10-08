// @effect-diagnostics globalDate:off
/**
 * Fork (Owner): who a peer request comes from. The source server vouches for
 * the calling thread; the receiving server acts for it as a client whose
 * permission ceiling is that thread's runtime mode.
 */
import { RuntimeMode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";

export const PeerSource = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  runtimeMode: RuntimeMode,
});
export type PeerSource = typeof PeerSource.Type;

export const peerScope = (environmentId: string, source: PeerSource): McpInvocationScope => ({
  environmentId: environmentId as McpInvocationScope["environmentId"],
  capabilities: new Set(["orchestration"]),
  issuedAt: Date.now(),
  requestNamespace: `fleet:${source.environmentId}:${source.threadId}`,
  thread: undefined,
  client: {
    sessionId: `fleet:${source.environmentId}:${source.threadId}`,
    label: `${source.label} · ${source.title}`,
    access: source.runtimeMode,
  },
});

/**
 * Fork (Owner): fleet agent awareness, one layer added to the MCP server.
 * See FORK.md "Fleet awareness".
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { toolkitRegistration } from "../../mcp/McpHttpServer.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../mcp/ThreadMetadataMcpService.ts";
import * as Handlers from "./handlers.ts";
import { runPublisher } from "./publisher.ts";
import * as Routes from "./routes.ts";
import { FleetToolkit } from "./tools.ts";

const layerPublisher = Layer.effectDiscard(
  runPublisher.pipe(
    Effect.catchCause((cause) => Effect.logWarning("fleet publisher stopped", { cause })),
    Effect.forkScoped,
  ),
);

/**
 * McpHttpServer passes its `toolkitRegistration` (the only way onto `/mcp`,
 * with each tool's declared access), so this module needs no runtime import
 * of McpHttpServer, which imports it.
 */
export const layer = (register: typeof toolkitRegistration) =>
  Layer.mergeAll(register(FleetToolkit, Handlers.layer), Routes.layer, layerPublisher).pipe(
    Layer.provide(OrchestratorMcpService.layer),
    Layer.provide(ThreadMetadataMcpService.layer),
  );

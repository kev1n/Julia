/**
 * Fork: fleet agent awareness, added to the MCP server and beside its `/mcp` route.
 * See FORK.md "Fleet awareness".
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { toolkitRegistration } from "../../mcp/McpHttpServer.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../mcp/ThreadMetadataMcpService.ts";
import * as Handlers from "./handlers.ts";
import { runPublisher } from "./publisher.ts";
import { runDelivery } from "./remoteTasks.ts";
import * as Routes from "./routes.ts";
import { FleetToolkit } from "./tools.ts";

const layerPublisher = Layer.effectDiscard(
  runPublisher.pipe(
    Effect.catchCause((cause) => Effect.logWarning("fleet publisher stopped", { cause })),
    Effect.forkScoped,
  ),
);

const layerRemoteTaskDelivery = Layer.effectDiscard(
  runDelivery.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("fleet remote task delivery stopped", { cause }),
    ),
    Effect.forkScoped,
  ),
);

/**
 * McpHttpServer passes its `toolkitRegistration` (the only way onto `/mcp`,
 * with each tool's declared access), so this module needs no runtime import
 * of McpHttpServer, which imports it.
 */
export const layer = (register: typeof toolkitRegistration) =>
  Layer.mergeAll(
    register(FleetToolkit, Handlers.layer),
    layerPublisher,
    layerRemoteTaskDelivery,
  ).pipe(
    Layer.provide(OrchestratorMcpService.layer),
    Layer.provide(ThreadMetadataMcpService.layer),
  );

/** `/fork/fleet/*`, authorized by the fleet secret alone: McpHttpServer mounts it beside `/mcp`. */
export const layerRoutes = Routes.layer.pipe(Layer.provide(OrchestratorMcpService.layer));

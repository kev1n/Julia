import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Handlers from "./handlers.ts";
import * as FleetSuggestions from "./threadOverlaps.ts";
import { FleetToolkit } from "./tools.ts";

it.effect("registers the fleet tools including the no-argument coordination tool", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.some(({ tool }) => tool.name === "t3_coordination_suggestions")).toBe(true);
    expect(server.tools.some(({ tool }) => tool.name === "t3_who_else")).toBe(true);
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(FleetToolkit, Handlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ServerEnvironment.ServerEnvironment)({}),
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(FleetSuggestions.FleetSuggestions)({}),
          ),
        ),
      ),
    ),
  ),
);

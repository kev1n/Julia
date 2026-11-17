import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { layer } from "./handlers.ts";

// The server builds this at start and dies if a declaration and its tool disagree.
it.effect("the fleet toolkit's declarations match its tools", () =>
  Effect.gen(function* () {
    const built = yield* Layer.build(McpToolAccess.HandlersLayer.layer(layer)).pipe(
      Effect.scoped,
      Effect.exit,
    );
    expect(built).toSatisfy(Exit.isSuccess);
  }),
);

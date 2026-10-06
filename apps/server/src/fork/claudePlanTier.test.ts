import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeTierMultiplier,
  readClaudeTierMultiplier,
  withClaudeTier,
} from "./claudePlanTier.ts";

describe("Claude plan tier", () => {
  it("reads the multiplier from the profile's rate-limit tier", () => {
    assert.strictEqual(claudeTierMultiplier("default_claude_max_20x"), "20");
    assert.strictEqual(claudeTierMultiplier("default_claude_max_5x"), "5");
    assert.strictEqual(claudeTierMultiplier("default_claude_ai"), null);
    assert.strictEqual(claudeTierMultiplier(null), null);
  });

  it("turns a Max plan plus a tier into the slug the provider labels Max 20x", () => {
    assert.strictEqual(withClaudeTier("max", "20"), "max20");
    // What the Claude Agent SDK reports in its init message.
    assert.strictEqual(withClaudeTier("Claude Max", "5"), "max5");
    assert.strictEqual(withClaudeTier("claude_max_subscription", "20"), "max20");
    assert.strictEqual(withClaudeTier("max", null), "max");
    assert.strictEqual(withClaudeTier("pro", "20"), "pro");
    assert.strictEqual(withClaudeTier(undefined, "20"), undefined);
  });

  it.effect("reads the tier from a real-shaped profile with unrelated keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "claude-tier-" });
      yield* fs.writeFileString(path.join(dir, ".claude.json"), PROFILE);
      assert.strictEqual(yield* readClaudeTierMultiplier({ CLAUDE_CONFIG_DIR: dir }), "20");
      assert.strictEqual(
        yield* readClaudeTierMultiplier({ CLAUDE_CONFIG_DIR: path.join(dir, "missing") }),
        null,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// Trimmed from a real ~/.claude.json: unrelated keys around the account profile.
const PROFILE = `{
  "numStartups": 3,
  "projects": { "/x": { "allowedTools": [] } },
  "oauthAccount": {
    "accountUuid": "a",
    "emailAddress": "someone@example.com",
    "seatTier": null,
    "organizationType": "claude_max",
    "organizationRateLimitTier": "default_claude_max_20x",
    "userRateLimitTier": null
  }
}`;

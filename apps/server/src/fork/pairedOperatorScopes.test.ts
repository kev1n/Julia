import { assert, it } from "@effect/vitest";
import { AuthProvidersManageScope, AuthSettingsWriteScope } from "@t3tools/contracts";

import { pairedOperatorScopes } from "./pairedOperatorScopes.ts";

const OLD_PAIRING = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
] as const;

it("lets an old full-control pairing manage providers and settings", () => {
  const scopes = pairedOperatorScopes("one-time-token", OLD_PAIRING);
  assert.include(scopes, AuthProvidersManageScope);
  assert.include(scopes, AuthSettingsWriteScope);
  assert.includeMembers([...scopes], [...OLD_PAIRING]);
  assert.strictEqual(new Set(scopes).size, scopes.length);
});

it("keeps a read-only pairing read-only", () => {
  const scopes = ["orchestration:read", "relay:read"] as const;
  assert.deepStrictEqual(pairedOperatorScopes("one-time-token", scopes), scopes);
});

it("leaves agent and CLI sessions with what they were issued", () => {
  assert.deepStrictEqual(pairedOperatorScopes("mcp-client", OLD_PAIRING), OLD_PAIRING);
  assert.deepStrictEqual(pairedOperatorScopes("browser", OLD_PAIRING), OLD_PAIRING);
});

import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
} from "../provider/CodexProvider.ts";

it("defaults Codex to GPT-6.2-Sol", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "gpt-6-astra",
      name: "GPT-6-Astra",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isCustom: false, capabilities: null },
    { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["gpt-6.2-sol"],
  );
});

it("defaults GPT-6.2-Sol to High reasoning", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "low",
    description: "",
    displayName: "GPT-6.2-Sol",
    hidden: false,
    id: "gpt-6.2-sol",
    isDefault: true,
    model: "gpt-6.2-sol",
    supportedReasoningEfforts: [
      { description: "", reasoningEffort: "low" },
      { description: "", reasoningEffort: "high" },
    ],
  });
  const reasoning = capabilities.optionDescriptors?.find(
    (option) => option.id === "reasoningEffort",
  );
  assert.strictEqual(
    reasoning?.type === "select" ? reasoning.options.find((option) => option.isDefault)?.id : null,
    "high",
  );
});

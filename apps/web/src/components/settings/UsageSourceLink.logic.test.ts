import {
  ProviderDriverKind,
  UsageLimitSourceId,
  type ProviderInstanceConfig,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { suggestedUsageLimitSource } from "./UsageSourceLink.logic";

const sources: UnifiedSettings["usageLimitSources"] = {
  [UsageLimitSourceId.make("hub")]: {
    kind: "cliproxy",
    url: "http://studio.example:8317",
    managementKey: "",
    enabled: true,
  },
};

describe("suggestedUsageLimitSource", () => {
  it("suggests the hub a Claude instance's base URL points at", () => {
    const claude: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("claudeAgent"),
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "http://studio.example:8317", sensitive: false },
      ],
    };
    expect(suggestedUsageLimitSource(claude, sources)).toBe("hub");
  });

  it("reads the base_url in Codex launch arguments", () => {
    const codex: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("codex"),
      config: {
        launchArgs:
          '-c model_provider="cliproxy" -c model_providers.cliproxy.base_url="http://studio.example:8317/v1"',
      },
    };
    expect(suggestedUsageLimitSource(codex, sources)).toBe("hub");
  });

  it("suggests nothing for another address", () => {
    const other: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("claudeAgent"),
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "http://studio.example:9999", sensitive: false },
      ],
    };
    expect(suggestedUsageLimitSource(other, sources)).toBeNull();
  });
});

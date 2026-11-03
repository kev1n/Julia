import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { autoPlacementLabel } from "./useAutoAccount";

const environments = [
  { environmentId: "studio-a", label: "studio-a" },
  { environmentId: "studio-b", label: "studio-b" },
];
const claude = "claudeAgent" as ProviderDriverKind;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const account = {
  account: {
    displayName: "Claude bob",
    auth: {
      status: "authenticated",
      label: "Claude Max 20x Subscription",
      email: "bob@example.com",
    },
    usageLimits: {
      checkedAt: new Date(NOW).toISOString(),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 8,
          resetsAt: inHours(2),
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 60,
          resetsAt: inHours(72),
        },
      ],
    },
  } as unknown as ServerProvider,
  standing: {
    sessionLeft: 92,
    weeklyLeft: 40,
    monthlyLeft: null,
    tightestLeft: 40,
    limited: false,
  },
};

describe("autoPlacementLabel", () => {
  it("names the machine, the account, its plan, each window, and when they refill", () => {
    const label = autoPlacementLabel({
      placement: {
        pending: false,
        failed: false,
        lastChosen: { environmentId: "studio-b", reason: "most free memory" },
      },
      environmentId: "studio-b",
      environments,
      driver: claude,
      account,
      now: NOW,
    });
    expect(label.chip).toBe("studio-b · bob · 40% week");
    expect(label.detail.split("\n")).toEqual([
      "Auto chose studio-b: most free memory",
      "Claude bob (Max 20x)",
      expect.stringMatching(/^92% session · resets /),
      expect.stringMatching(/^40% week · resets /),
    ]);
  });

  it("says so when no machine is eligible", () => {
    expect(
      autoPlacementLabel({
        placement: { pending: false, failed: true, lastChosen: null },
        environmentId: null,
        environments,
        driver: claude,
        account: null,
        now: NOW,
      }).chip,
    ).toBe("Auto · no eligible machine online");
  });
});

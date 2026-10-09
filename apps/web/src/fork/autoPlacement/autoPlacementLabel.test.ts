import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { autoPlacementLabel } from "./useAutoAccount";

const environments = [
  { environmentId: "mac-a", label: "mac-a" },
  { environmentId: "build-mac", label: "build-mac" },
];
const claude = "claudeAgent" as ProviderDriverKind;
const account = {
  account: {
    displayName: "Claude owner",
    auth: {
      status: "authenticated",
      label: "Claude Max 20x Subscription",
      email: "owner@gmail.com",
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
  it("names the machine, the account with its plan, and why", () => {
    expect(
      autoPlacementLabel({
        placement: {
          pending: false,
          failed: false,
          lastChosen: { environmentId: "build-mac", reason: "most free memory" },
        },
        environmentId: "build-mac",
        environments,
        driver: claude,
        account,
      }),
    ).toEqual({
      chip: "build-mac · owner · 40% week",
      detail: "Auto chose build-mac: most free memory · Claude owner (Max 20x): 40% week left",
    });
  });

  it("says so when no machine is eligible", () => {
    expect(
      autoPlacementLabel({
        placement: { pending: false, failed: true, lastChosen: null },
        environmentId: null,
        environments,
        driver: claude,
        account: null,
      }).chip,
    ).toBe("Auto · no eligible machine online");
  });
});

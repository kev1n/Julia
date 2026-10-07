import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { accountLimitSummary } from "./accountSummary";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function provider(input: {
  displayName?: string;
  email?: string;
  plan?: string;
  session?: number;
  sessionResetsAt?: string;
  weekly?: number;
}): Parameters<typeof accountLimitSummary>[0] {
  const windows: NonNullable<ServerProvider["usageLimits"]>["windows"][number][] = [];
  if (input.session !== undefined) {
    windows.push({
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: input.session,
      resetsAt: input.sessionResetsAt ?? inHours(2),
    });
  }
  if (input.weekly !== undefined) {
    windows.push({
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: input.weekly,
      resetsAt: inHours(72),
    });
  }
  return {
    ...(input.displayName ? { displayName: input.displayName } : {}),
    auth: {
      status: "authenticated",
      ...(input.email ? { email: input.email } : {}),
      ...(input.plan ? { label: input.plan } : {}),
    },
    usageLimits: { checkedAt: new Date(NOW).toISOString(), windows },
  };
}

describe("accountLimitSummary", () => {
  it("names the login, the plan and what is left in each window", () => {
    expect(
      accountLimitSummary(
        provider({
          displayName: "Claude",
          email: "owner@gmail.com",
          plan: "Claude Max 20x Subscription",
          session: 12,
          weekly: 39,
        }),
        NOW,
      ),
    ).toBe("owner · Max 20x · 88% session · 61% week");
  });

  it("leaves out the login when the instance is already named after it", () => {
    expect(
      accountLimitSummary(
        provider({ displayName: "Claude owner", email: "owner@gmail.com", session: 50 }),
        NOW,
      ),
    ).toBe("50% session");
  });

  it("counts a session whose reset has passed as full", () => {
    expect(accountLimitSummary(provider({ session: 100, sessionResetsAt: inHours(-1) }), NOW)).toBe(
      "100% session",
    );
  });

  it("says when an account with no limit left comes back instead of its percentages", () => {
    const summary = accountLimitSummary(
      provider({ plan: "Claude Max 20x Subscription", session: 100, weekly: 40 }),
      NOW,
    );
    expect(summary).toMatch(/^Max 20x · no limit left · back /);
    expect(summary).not.toContain("%");
  });

  it("is null when the instance reports nothing", () => {
    expect(accountLimitSummary(provider({}), NOW)).toBeNull();
  });
});

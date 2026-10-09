import { describe, expect, it } from "vite-plus/test";

import { briefDuration, usageBars } from "./usageBarData";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

describe("briefDuration", () => {
  it("keeps one or two digits", () => {
    expect(briefDuration(42 * 60_000)).toBe("42m");
    expect(briefDuration(5.2 * 3_600_000)).toBe("5.2h");
    expect(briefDuration(14.4 * 3_600_000)).toBe("14h");
    expect(briefDuration(60 * 3_600_000)).toBe("2.5d");
  });
});

describe("usageBars", () => {
  it("puts the session first and the tightest week second", () => {
    expect(
      usageBars(
        {
          checkedAt: new Date(NOW).toISOString(),
          windows: [
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 30,
              resetsAt: inHours(60),
            },
            {
              id: "seven_day_opus",
              kind: "weekly",
              label: "Opus",
              usedPercent: 70,
              resetsAt: inHours(30),
            },
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 10,
              resetsAt: inHours(5.2),
            },
          ],
        },
        NOW,
      ),
    ).toEqual([
      { kind: "session", left: 90, resetsIn: "5.2h" },
      { kind: "weekly", left: 30, resetsIn: "30h" },
    ]);
  });

  it("refills a window whose reset has passed", () => {
    expect(
      usageBars(
        {
          checkedAt: new Date(NOW).toISOString(),
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 90,
              resetsAt: inHours(-1),
            },
          ],
        },
        NOW,
      ),
    ).toEqual([{ kind: "session", left: 100, resetsIn: null }]);
  });
});

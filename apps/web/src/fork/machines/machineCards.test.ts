import type { HostResourcesSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatSize, machineCard, offlineText } from "./machineCards";

const GIB = 1024 ** 3;
const snapshot: HostResourcesSnapshot = {
  sampledAt: 1_000_000,
  cpuUtilization: 0.374,
  cpuCount: 10,
  availableMemoryBytes: 8 * GIB,
  totalMemoryBytes: 32 * GIB,
  freeDiskBytes: 400e9,
  totalDiskBytes: 1_000e9,
};

describe("machineCard", () => {
  it("shows CPU, memory used of total and disk used of total for a connected machine", () => {
    expect(machineCard({ connected: true, resources: snapshot, failed: false }, null)).toEqual({
      kind: "online",
      cpu: { percent: 37, detail: "10 cores" },
      memory: { percent: 75, detail: "24 GB of 32 GB" },
      disk: { percent: 60, detail: "600 GB of 1 TB" },
    });
  });

  it("leaves disk out for a server that predates total disk", () => {
    const { totalDiskBytes: _, ...old } = snapshot;
    const card = machineCard({ connected: true, resources: old, failed: false }, null);
    expect(card.kind === "online" && card.disk).toBeNull();
  });

  it("is loading until the first snapshot arrives", () => {
    expect(machineCard({ connected: true, resources: null, failed: false }, null)).toEqual({
      kind: "loading",
    });
  });

  it("is offline with the newest snapshot time it saw when the connection drops", () => {
    expect(machineCard({ connected: false, resources: snapshot, failed: false }, 900_000)).toEqual({
      kind: "offline",
      lastSeenAt: 1_000_000,
    });
    expect(machineCard({ connected: false, resources: null, failed: false }, 900_000)).toEqual({
      kind: "offline",
      lastSeenAt: 900_000,
    });
  });

  it("is offline when a connected server stops answering", () => {
    expect(machineCard({ connected: true, resources: snapshot, failed: true }, null)).toEqual({
      kind: "offline",
      lastSeenAt: 1_000_000,
    });
  });

  it("is offline and never seen when the client has no snapshot at all", () => {
    expect(machineCard({ connected: false, resources: null, failed: false }, null)).toEqual({
      kind: "offline",
      lastSeenAt: null,
    });
  });
});

describe("formatSize", () => {
  it("counts memory in binary units and disk in decimal ones", () => {
    expect(formatSize(16 * GIB, "memory")).toBe("16 GB");
    expect(formatSize(494.4e9, "disk")).toBe("494 GB");
    expect(formatSize(12.34e9, "disk")).toBe("12.3 GB");
    expect(formatSize(2e12, "disk")).toBe("2 TB");
  });
});

describe("offlineText", () => {
  it("says how long ago the machine was last seen", () => {
    expect(offlineText(null, 0)).toBe("Offline · not seen since the app opened");
    expect(offlineText(1_000, 30_000)).toBe("Offline · last seen just now");
    expect(offlineText(0, 3 * 3_600_000 + 12 * 60_000)).toBe("Offline · last seen 3h 12m ago");
  });
});

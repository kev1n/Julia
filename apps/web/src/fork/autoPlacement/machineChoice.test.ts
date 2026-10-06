import { describe, expect, it } from "vite-plus/test";

import { autoWeight, chooseAutoMachine, type MachineFacts } from "./machineChoice";

const GB = 1024 ** 3;
const machine = (
  label: string,
  memoryGb: number,
  running: number,
  diskGb: number | null,
): MachineFacts => ({
  environmentId: label,
  label,
  availableMemoryBytes: memoryGb * GB,
  runningThreadCount: running,
  freeDiskBytes: diskGb === null ? null : diskGb * GB,
});

describe("chooseAutoMachine", () => {
  it("prefers the most available memory", () => {
    expect(
      chooseAutoMachine([machine("mac-a", 7.4, 0, 500), machine("build-mac", 11.4, 3, 100)]),
    ).toEqual({
      kind: "chosen",
      environmentId: "build-mac",
      reason: "most free memory",
    });
  });

  it("then fewer running threads", () => {
    expect(chooseAutoMachine([machine("mac-a", 8, 2, 500), machine("build-mac", 8, 1, 100)])).toEqual({
      kind: "chosen",
      environmentId: "build-mac",
      reason: "fewest running threads",
    });
  });

  it("then more free disk, with unknown disk last", () => {
    expect(
      chooseAutoMachine([
        machine("old", 8, 1, null),
        machine("mac-a", 8, 1, 50),
        machine("build-mac", 8, 1, 145),
      ]),
    ).toEqual({ kind: "chosen", environmentId: "build-mac", reason: "most free disk" });
  });

  it("says when only one machine is eligible", () => {
    expect(chooseAutoMachine([machine("mac-a", 1, 9, 1)])).toMatchObject({
      environmentId: "mac-a",
      reason: "only eligible machine",
    });
  });

  it("reports an error when no machine is eligible", () => {
    expect(chooseAutoMachine([])).toEqual({
      kind: "none",
      reason: "No eligible machine is online",
    });
  });
});

describe("autoWeight", () => {
  it("leaves a laptop out until its preference is set", () => {
    expect(autoWeight({}, "macbook", "laptop")).toBe(0);
    expect(autoWeight({ macbook: 50 }, "macbook", "laptop")).toBe(50);
    expect(autoWeight({}, "mac-a", "mac-mini")).toBe(50);
    expect(autoWeight({ mac-a: 0 }, "mac-a", "mac-mini")).toBe(0);
  });
});

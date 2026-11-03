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
      chooseAutoMachine([machine("studio-a", 7.4, 0, 500), machine("studio-b", 11.4, 3, 100)]),
    ).toEqual({
      kind: "chosen",
      environmentId: "studio-b",
      reason: "most free memory",
    });
  });

  it("then fewer running threads", () => {
    expect(
      chooseAutoMachine([machine("studio-a", 8, 2, 500), machine("studio-b", 8, 1, 100)]),
    ).toEqual({
      kind: "chosen",
      environmentId: "studio-b",
      reason: "fewest running threads",
    });
  });

  it("then more free disk, with unknown disk last", () => {
    expect(
      chooseAutoMachine([
        machine("old", 8, 1, null),
        machine("studio-a", 8, 1, 50),
        machine("studio-b", 8, 1, 145),
      ]),
    ).toEqual({ kind: "chosen", environmentId: "studio-b", reason: "most free disk" });
  });

  it("says when only one machine is eligible", () => {
    expect(chooseAutoMachine([machine("studio-a", 1, 9, 1)])).toMatchObject({
      environmentId: "studio-a",
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
    expect(autoWeight({}, "studio-a", "mac-mini")).toBe(50);
    expect(autoWeight({ "studio-a": 0 }, "studio-a", "mac-mini")).toBe(0);
  });
});

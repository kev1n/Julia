import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { outageBannerText, outageCause } from "./outageCause";

const environment = (
  label: string,
  phase: EnvironmentConnectionPhase,
  displayUrl: string | null = `https://${label}.example.ts.net`,
) => ({
  environmentId: EnvironmentId.make(label),
  label,
  displayUrl,
  connection: { phase },
});

const laptop = EnvironmentId.make("laptop");

describe("outageCause", () => {
  it("blames the server when another machine is connected", () => {
    expect(
      outageCause({
        networkStatus: "online",
        unavailableEnvironmentId: laptop,
        environments: [
          environment("laptop", "reconnecting"),
          environment("studio", "connected"),
          environment("office", "reconnecting"),
        ],
      }),
    ).toEqual({ _tag: "server", connectedLabel: "studio" });
  });

  it("blames this device's network when every machine is unreachable", () => {
    expect(
      outageCause({
        networkStatus: "online",
        unavailableEnvironmentId: laptop,
        environments: [
          environment("laptop", "reconnecting"),
          environment("studio", "reconnecting"),
          environment("office", "error"),
        ],
      }),
    ).toEqual({ _tag: "device-network" });
  });

  it("does not count a server on this device as proof the network works", () => {
    expect(
      outageCause({
        networkStatus: "online",
        unavailableEnvironmentId: laptop,
        environments: [
          environment("laptop", "reconnecting"),
          environment("Local", "connected", "http://127.0.0.1:3773"),
          environment("studio", "reconnecting"),
        ],
      }),
    ).toEqual({ _tag: "device-network" });
  });

  it("ignores machines the client is not trying to reach", () => {
    expect(
      outageCause({
        networkStatus: "online",
        unavailableEnvironmentId: laptop,
        environments: [environment("laptop", "reconnecting"), environment("studio", "available")],
      }),
    ).toEqual({ _tag: "unknown" });
  });

  it("reports the device offline when the browser says so", () => {
    expect(
      outageCause({
        networkStatus: "offline",
        unavailableEnvironmentId: laptop,
        environments: [environment("laptop", "offline"), environment("studio", "connected")],
      }),
    ).toEqual({ _tag: "device-offline" });
  });
});

describe("outageBannerText", () => {
  it("names the cause in the title", () => {
    expect(
      outageBannerText({
        label: "laptop",
        reconnecting: true,
        cause: { _tag: "server", connectedLabel: "studio" },
      }).title,
    ).toBe("laptop isn't responding");
    expect(
      outageBannerText({ label: "studio", reconnecting: true, cause: { _tag: "device-network" } })
        .title,
    ).toBe("studio is reconnecting: your network");
    expect(
      outageBannerText({ label: "studio", reconnecting: false, cause: { _tag: "unknown" } }),
    ).toEqual({ title: "studio is offline", description: null });
  });
});

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

const macbook = EnvironmentId.make("MacBook");

describe("outageCause", () => {
  it("blames the server when another machine is connected", () => {
    expect(
      outageCause({
        networkStatus: "online",
        unavailableEnvironmentId: macbook,
        environments: [
          environment("MacBook", "reconnecting"),
          environment("mac-a", "connected"),
          environment("build-mac", "reconnecting"),
        ],
      }),
    ).toEqual({ _tag: "server", connectedLabel: "mac-a" });
  });

  it("blames this device's network when every machine is unreachable", () => {
    expect(
      outageCause({
        networkStatus: "online",
        unavailableEnvironmentId: macbook,
        environments: [
          environment("MacBook", "reconnecting"),
          environment("mac-a", "reconnecting"),
          environment("build-mac", "error"),
        ],
      }),
    ).toEqual({ _tag: "device-network" });
  });

  it("does not count a server on this device as proof the network works", () => {
    expect(
      outageCause({
        networkStatus: "online",
        unavailableEnvironmentId: macbook,
        environments: [
          environment("MacBook", "reconnecting"),
          environment("Local", "connected", "http://127.0.0.1:3773"),
          environment("mac-a", "reconnecting"),
        ],
      }),
    ).toEqual({ _tag: "device-network" });
  });

  it("ignores machines the client is not trying to reach", () => {
    expect(
      outageCause({
        networkStatus: "online",
        unavailableEnvironmentId: macbook,
        environments: [environment("MacBook", "reconnecting"), environment("mac-a", "available")],
      }),
    ).toEqual({ _tag: "unknown" });
  });

  it("reports the device offline when the browser says so", () => {
    expect(
      outageCause({
        networkStatus: "offline",
        unavailableEnvironmentId: macbook,
        environments: [environment("MacBook", "offline"), environment("mac-a", "connected")],
      }),
    ).toEqual({ _tag: "device-offline" });
  });
});

describe("outageBannerText", () => {
  it("names the cause in the title", () => {
    expect(
      outageBannerText({
        label: "MacBook",
        reconnecting: true,
        cause: { _tag: "server", connectedLabel: "mac-a" },
      }).title,
    ).toBe("MacBook isn't responding");
    expect(
      outageBannerText({ label: "mac-a", reconnecting: true, cause: { _tag: "device-network" } })
        .title,
    ).toBe("mac-a is reconnecting: your network");
    expect(
      outageBannerText({ label: "mac-a", reconnecting: false, cause: { _tag: "unknown" } }),
    ).toEqual({ title: "mac-a is offline", description: null });
  });
});

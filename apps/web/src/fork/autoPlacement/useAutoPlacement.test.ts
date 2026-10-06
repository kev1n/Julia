import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isAutoCandidate } from "./useAutoPlacement";

const instanceId = ProviderInstanceId.make("claudeAgent");
const projectId = ProjectId.make("project-1");

const provider = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    instanceId,
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    availability: "available",
    ...overrides,
  }) as unknown as ServerProvider;

const candidate = (input: Partial<Parameters<typeof isAutoCandidate>[0]>) =>
  isAutoCandidate({
    environmentId: "build-mac",
    connected: true,
    serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
    providers: [provider()],
    projectId,
    kind: "mac-mini",
    weights: {},
    driver: "claudeAgent",
    ...input,
  });

describe("isAutoCandidate", () => {
  // Provider statuses no longer ride on the server config, so a machine whose
  // provider list has not arrived cannot take an Auto thread yet.
  it("needs a usable provider of the driver in the machine's own provider list", () => {
    expect(candidate({})).toBe(true);
    expect(candidate({ providers: undefined })).toBe(false);
    expect(candidate({ providers: [provider({ driver: "codex" })] })).toBe(false);
    expect(candidate({ providers: [provider({ auth: { status: "unauthenticated" } })] })).toBe(
      false,
    );
    expect(candidate({ connected: false })).toBe(false);
  });

  it("leaves out a machine whose provider is switched off for the destination project", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(candidate({ serverConfig: { settings } })).toBe(false);
    expect(candidate({ serverConfig: { settings }, projectId: ProjectId.make("project-2") })).toBe(
      true,
    );
  });
});

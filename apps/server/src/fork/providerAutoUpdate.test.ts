import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateStatus,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { nextAutoUpdate } from "./providerAutoUpdate.ts";

function provider(
  instanceId: string,
  overrides: {
    readonly driver?: string;
    readonly enabled?: boolean;
    readonly latestVersion?: string | null;
    readonly behind?: boolean;
    readonly canUpdate?: boolean;
    readonly updating?: ServerProviderUpdateStatus;
  } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(overrides.driver ?? "codex"),
    enabled: overrides.enabled ?? true,
    installed: true,
    version: "0.163.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-17T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: overrides.behind === false ? "current" : "behind_latest",
      currentVersion: "0.163.0",
      latestVersion: overrides.latestVersion === undefined ? "0.169.1" : overrides.latestVersion,
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: overrides.canUpdate ?? true,
      checkedAt: "2026-11-17T12:00:00.000Z",
      message: null,
    },
    ...(overrides.updating
      ? {
          updateState: {
            status: overrides.updating,
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        }
      : {}),
  };
}

it("picks a Codex instance that is behind and that this server can update", () => {
  const skipped = [
    provider("claude", { driver: "claudeAgent" }),
    provider("off", { enabled: false }),
    provider("current", { behind: false }),
    provider("manual", { canUpdate: false }),
    provider("unknown", { latestVersion: null }),
    provider("busy", { updating: "running" }),
  ];
  expect(nextAutoUpdate(skipped, new Map())).toBeUndefined();
  expect(nextAutoUpdate([...skipped, provider("codex")], new Map())).toMatchObject({
    instanceId: "codex",
    latestVersion: "0.169.1",
  });
});

it("tries a version once, and tries again when a newer one appears", () => {
  const attempted = new Map([["codex", "0.169.1"]]);
  expect(nextAutoUpdate([provider("codex")], attempted)).toBeUndefined();
  expect(
    nextAutoUpdate([provider("codex", { latestVersion: "0.170.0" })], attempted),
  ).toMatchObject({ latestVersion: "0.170.0" });
});

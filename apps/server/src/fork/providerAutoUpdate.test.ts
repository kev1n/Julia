import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { agedRelease, CLAUDE_MINIMUM_AGE_MS, nextAutoUpdate } from "./providerAutoUpdate.ts";

function provider(
  instanceId: string,
  overrides: {
    readonly driver?: string;
    readonly enabled?: boolean;
    readonly latestVersion?: string | null;
    readonly behind?: boolean;
    readonly canUpdate?: boolean;
    readonly updating?: ServerProviderUpdateStatus;
    readonly canInstallVersion?: boolean;
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
      ...(overrides.canInstallVersion === undefined
        ? {}
        : { canInstallVersion: overrides.canInstallVersion }),
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

const NOW = Date.parse("2026-11-18T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const published = (daysAgo: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW - daysAgo * DAY));
const version = (update: ReturnType<typeof nextAutoUpdate>) =>
  update && {
    instanceId: update.provider.instanceId,
    version: update.version,
    pinned: update.pinned,
  };

it("picks a Codex instance that is behind and that this server can update", () => {
  const skipped = [
    provider("off", { enabled: false }),
    provider("current", { behind: false }),
    provider("manual", { canUpdate: false }),
    provider("unknown", { latestVersion: null }),
    provider("busy", { updating: "running" }),
  ];
  expect(nextAutoUpdate(skipped, new Map(), null, NOW)).toBeUndefined();
  expect(version(nextAutoUpdate([...skipped, provider("codex")], new Map(), null, NOW))).toEqual({
    instanceId: "codex",
    version: "0.169.1",
    pinned: false,
  });
});

it("tries a version once, and tries again when a newer one appears", () => {
  const attempted = new Map([["codex", "0.169.1"]]);
  expect(nextAutoUpdate([provider("codex")], attempted, null, NOW)).toBeUndefined();
  expect(
    version(
      nextAutoUpdate([provider("codex", { latestVersion: "0.170.0" })], attempted, null, NOW),
    ),
  ).toMatchObject({ version: "0.170.0" });
});

it("pins Claude Code to the newest release that is three days old", () => {
  const releases = {
    created: published(900),
    "0.160.0": published(30),
    "0.164.0": published(4),
    "0.165.0-beta.1": published(3.5),
    "0.166.0": published(2.9),
    "0.169.1": published(0.1),
  };
  const claude = provider("claude", { driver: "claudeAgent", canInstallVersion: true });
  expect(version(nextAutoUpdate([claude], new Map(), releases, NOW))).toEqual({
    instanceId: "claude",
    version: "0.164.0",
    pinned: true,
  });
  // Without release dates, or without a way to install an exact version, it waits.
  expect(nextAutoUpdate([claude], new Map(), null, NOW)).toBeUndefined();
  expect(
    nextAutoUpdate([provider("wrapped", { driver: "claudeAgent" })], new Map(), releases, NOW),
  ).toBeUndefined();
  // Nothing old enough is newer than the installed 0.163.0.
  expect(
    agedRelease(
      { "0.163.0": published(9), "0.169.1": published(1) },
      "0.163.0",
      NOW,
      CLAUDE_MINIMUM_AGE_MS,
    ),
  ).toBeUndefined();
});

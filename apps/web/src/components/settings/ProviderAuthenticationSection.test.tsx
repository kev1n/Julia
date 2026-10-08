import type { ReactElement } from "react";
import { EnvironmentId, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

const state = vi.hoisted(() => ({ respond: vi.fn(), share: vi.fn(), toast: vi.fn() }));
const token = `sk-ant-oat01-${"test-token-".repeat(8)}`;
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useRef: reactHookHarness.useRef };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    error: null,
    data: {
      phase: "waiting",
      flowId: "flow",
      interaction: {
        type: "terminal",
        id: "terminal",
        output: `sk-ant-oat01-${"test-token-".repeat(8)}`,
        outputOffset: 100,
      },
    },
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: vi.fn(),
    respondProviderAuth: Symbol("respond"),
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.respond }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("./addProviderEverywhere", () => ({ useShareProviderSecret: () => state.share }));
vi.mock("./settingsLayout", () => ({ SettingsRow: () => null }));
vi.mock("../../lib/utils", () => ({ cn: () => "", randomUUID: () => "test-id" }));
vi.mock("../../localApi", () => ({ ensureLocalApi: vi.fn() }));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

function renderTokenStep() {
  hooks.beginRender();
  const section = ProviderAuthenticationSection({
    environmentId: EnvironmentId.make("build-mac"),
    environmentLabel: "build-mac",
    instanceId: ProviderInstanceId.make("claude_work"),
    readOnly: false,
    provider: { driver: "claudeAgent", auth: { status: "unauthenticated" } } as ServerProvider,
  });
  const tokenStep = visitElements(section, (element) => element.props.token === token);
  if (!tokenStep || typeof tokenStep.type !== "function") throw new Error("Token step not found");
  hooks.reset();
  return (tokenStep.type as (props: Record<string, unknown>) => ReactElement)(tokenStep.props);
}

async function saveToken(step: ReactElement) {
  const button = visitElements(
    step,
    (element) => element.props.children === "Save login to connected machines",
  );
  if (!button) throw new Error("Save login button not found");
  (button.props.onClick as () => void)();
  await state.respond.mock.results[0]?.value;
  await state.share.mock.results[0]?.value;
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.respond.mockResolvedValue({ _tag: "Success" });
  state.share.mockResolvedValue({
    description: "Saved on build-mac. Skipped mac-a (offline).",
    failed: [],
  });
});

describe("Claude login sharing", () => {
  it("waits for Save before copying the token and reports skipped machines", async () => {
    const step = renderTokenStep();
    expect(state.share).not.toHaveBeenCalled();
    expect(state.respond).not.toHaveBeenCalled();
    await saveToken(step);
    expect(state.share).toHaveBeenCalledWith({
      instanceId: "claude_work",
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: token,
      includeSource: true,
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        description: "Saved on build-mac. Skipped mac-a (offline).",
      }),
    );
  });

  it("does not copy credentials if the sign-in flow cannot be completed", async () => {
    state.respond.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("expired")) });
    await saveToken(renderTokenStep());
    expect(state.share).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("reports a failed machine copy as an error instead of a successful sync", async () => {
    state.share.mockResolvedValue({
      description: "Saved on build-mac. Could not save on mac-a.",
      failed: ["mac-a"],
    });
    await saveToken(renderTokenStep());
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "Saved on build-mac. Could not save on mac-a.",
      }),
    );
  });
});

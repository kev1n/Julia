import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useLayoutEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useAutoAccount, useLimitedAccountSwitch } from "./useAutoAccount";

vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-10-07T12:00" }));

function provider(id: string, driver: string, model: string, usedPercent?: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-07T12:00:00Z",
    models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...(usedPercent === undefined
      ? {}
      : {
          usageLimits: {
            checkedAt: "2026-10-07T12:00:00Z",
            windows: [{ id: "session", kind: "session", label: "Session", usedPercent }],
          },
        }),
  };
}

const opus: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeA"),
  model: "claude-opus-5-5",
};
const accounts = (used?: number) => [
  provider("claudeA", "claudeAgent", opus.model, used),
  provider("claudeB", "claudeAgent", opus.model, used),
  provider("codex", "codex", "gpt-6.1-sol", 20),
];
interface ComposerControls {
  readonly observed: ModelSelection;
  readonly manualPick: (selection: ModelSelection) => void;
  readonly newChat: () => void;
}

interface ComposerProbe {
  observed: ModelSelection | undefined;
  manualPick: (selection: ModelSelection) => void;
  newChat: () => void;
  readonly report: (controls: ComposerControls) => void;
}

/** Each test owns its probe, which the composer reports into on every commit. */
function createProbe(): ComposerProbe {
  const probe: ComposerProbe = {
    observed: undefined,
    manualPick: () => {},
    newChat: () => {},
    report: (controls) => Object.assign(probe, controls),
  };
  return probe;
}

function Composer({
  probe,
  providers,
  auto,
  started = false,
}: {
  probe: ComposerProbe;
  providers: ReadonlyArray<ServerProvider>;
  auto: boolean;
  started?: boolean;
}) {
  const [selection, setSelection] = useState(opus);
  const [explicit, setExplicit] = useState(false);
  const [draft, setDraft] = useState(1);
  useAutoAccount({
    enabled: auto && !started,
    environmentId: "studio-b",
    providers,
    driver:
      providers.find((provider) => provider.instanceId === selection.instanceId)?.driver ??
      "claudeAgent",
    currentInstanceId: selection.instanceId,
    model: selection.model,
    explicit,
    draftId: `draft-${draft}`,
    select: (instanceId) => setSelection((current) => ({ ...current, instanceId })),
  });
  useLimitedAccountSwitch({
    draftId: started ? null : `draft-${draft}`,
    providers,
    settings: DEFAULT_UNIFIED_SETTINGS,
    currentSelection: selection,
    explicit,
    select: setSelection,
  });
  const { report } = probe;
  useLayoutEffect(() => {
    report({
      observed: selection,
      manualPick: (next) => {
        setSelection(next);
        setExplicit(true);
      },
      newChat: () => {
        setSelection(opus);
        setExplicit(false);
        setDraft((current) => current + 1);
      },
    });
  });
  return null;
}

describe("new-chat quota fallback", () => {
  it.each([true, false])(
    "switches exhausted defaults in Auto=%s and preserves a later manual override",
    async (auto) => {
      const probe = createProbe();
      await using screen = await render(
        <Composer probe={probe} auto={auto} providers={accounts(100)} />,
      );
      expect(probe.observed?.model).toBe("gpt-6.1-sol");
      await act(() => probe.manualPick(opus));
      await screen.rerender(<Composer probe={probe} auto={auto} providers={accounts(99)} />);
      expect(probe.observed).toBe(opus);
      await act(() => probe.newChat());
      expect(probe.observed?.model).toBe("gpt-6.1-sol");
    },
  );

  it("waits for quota data arriving after the draft opened", async () => {
    const probe = createProbe();
    await using screen = await render(
      <Composer probe={probe} auto={false} providers={accounts()} />,
    );
    expect(probe.observed).toBe(opus);
    await screen.rerender(<Composer probe={probe} auto={false} providers={accounts(100)} />);
    expect(probe.observed?.model).toBe("gpt-6.1-sol");
  });

  it("does not change an existing conversation", async () => {
    const probe = createProbe();
    await using _screen = await render(
      <Composer probe={probe} auto={true} started providers={accounts(100)} />,
    );
    expect(probe.observed).toBe(opus);
  });
});

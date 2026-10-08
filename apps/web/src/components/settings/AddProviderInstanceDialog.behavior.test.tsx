import type { ComponentProps, ElementType, ReactElement } from "react";
import * as Cause from "effect/Cause";
import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { RadioGroup } from "../ui/radio-group";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";

const state = vi.hoisted(() => ({ persist: vi.fn(), fanOut: vi.fn(), close: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useMemo: reactHookHarness.useMemo };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_UNIFIED_SETTINGS,
  usePersistEnvironmentProviderInstanceMutation: () => state.persist,
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/managedPolicy", () => ({
  useManagedPolicy: () => undefined,
  managedInstanceLocks: () => undefined,
}));
vi.mock("./SecretSourceInput", () => ({
  SecretSourceInput: () => null,
  useSecretSources: () => [],
}));
vi.mock("./addProviderEverywhere", () => ({
  AddEverywhereRow: () => null,
  useAddProviderEverywhere: () => ({
    enabled: true,
    setEnabled: vi.fn(),
    otherLabels: ["mac-a"],
    addToOtherMachines: state.fanOut,
  }),
}));
vi.mock("./ProviderWizardAuthenticationStep", () => ({
  ProviderWizardAuthenticationStep: () => null,
}));
vi.mock("./CodexSetupSection", () => ({ AddManagedCodexAccountDialog: () => null }));
vi.mock("./ProviderInstanceCard", () => ({ ProviderEnvironmentSection: () => null }));
vi.mock("./AcpRegistrySearchStep", () => ({
  AcpRegistrySearchStep: () => null,
  useAcpRegistrySearch: () => ({ preparingId: null }),
}));
vi.mock("./MultipleAccountsNote", () => ({ MultipleAccountsNote: () => null }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/dialog", () => ({ Dialog: () => null }));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("./settingsLayout", () => ({ SettingsRow: () => null }));
vi.mock("../../lib/utils", () => ({ cn: () => "", randomUUID: () => "isolated-slot" }));

function render() {
  hooks.beginRender();
  return AddProviderInstanceDialog({
    open: true,
    environmentId: EnvironmentId.make("build-mac"),
    environmentLabel: "build-mac",
    onOpenChange: state.close,
  });
}

function findComponent<T extends ElementType>(
  tree: unknown,
  component: T,
): ReactElement<ComponentProps<T>> {
  const element = visitElements(tree, (candidate) => candidate.type === component);
  if (!element) throw new Error("Component not found");
  return element as ReactElement<ComponentProps<T>>;
}

function chooseClaude() {
  const providers = visitElements(
    render(),
    (element) => element.props["aria-labelledby"] === "add-instance-driver-label",
  );
  if (!providers) throw new Error("Provider choice not found");
  (providers.props.onValueChange as (value: string) => void)("claudeAgent");
  findComponent(render(), AddProviderInstanceWizardSteps).props.onNavigation({
    kind: "navigate",
    step: 2,
  });
}

async function save() {
  const button = visitElements(
    render(),
    (element) => element.props.children === "Continue to sign-in",
  );
  if (!button) throw new Error("Save button not found");
  (button.props.onClick as () => void)();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.persist.mockResolvedValue({ _tag: "Success", value: undefined });
  state.fanOut.mockResolvedValue(null);
});

describe("adding a Claude account", () => {
  it("persists an isolated login, copies that same slot, and stays open for sign-in", async () => {
    chooseClaude();
    await save();
    const mutation = state.persist.mock.calls[0]?.[0];
    expect(mutation).toMatchObject({
      operation: "create",
      instanceId: "claudeAgent_2",
      instance: { driver: "claudeAgent" },
    });
    expect(mutation.instance.config.homePath).toMatch(/^~\/\.claude-t3\/claudeAgent_2-/);
    expect(state.fanOut).toHaveBeenCalledWith(mutation.instanceId, mutation.instance);
    expect(state.close).not.toHaveBeenCalled();
    expect(findComponent(render(), ProviderWizardAuthenticationStep).props.instanceId).toBe(
      mutation.instanceId,
    );
  });

  it("reuses the machine login only after the explicit existing-login choice", async () => {
    chooseClaude();
    const choice = visitElements(
      render(),
      (element) => element.props["aria-label"] === "Claude account setup",
    ) as ReactElement<ComponentProps<typeof RadioGroup>>;
    choice.props.onValueChange?.("existing", {} as never);
    await save();
    expect(state.persist.mock.calls[0]?.[0].instance.config?.homePath).toBeUndefined();
    expect(findComponent(render(), ProviderWizardAuthenticationStep).props.instanceId).toBe(
      "claudeAgent_2",
    );
  });

  it("does not open sign-in or copy slots after creation fails", async () => {
    state.persist.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    chooseClaude();
    await save();
    expect(state.fanOut).not.toHaveBeenCalled();
    expect(
      visitElements(render(), (element) => element.type === ProviderWizardAuthenticationStep),
    ).toBeNull();
    expect(state.close).not.toHaveBeenCalled();
  });
});

/**
 * Fork (Owner): with Auto on, the composer uses the account `chooseAutoAccount`
 * picks among the chosen machine's instances of the selected provider, and
 * the composer line says what Auto chose and why.
 */
import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  accountStanding,
  chooseAutoAccount,
  usableInstances,
  type AccountChoice,
} from "@t3tools/shared/accountChoice";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { providerClients } from "../../components/settings/providerDriverMeta";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { shortPlanLabel } from "./planLabel";
import { resolveNewChatModelSelection } from "../../modelSelection";

/**
 * Applies the Auto account to each draft once per machine/model/choice.
 * Explicit account or model picks stay picked even if Auto's answer changes.
 */
export function useAutoAccount(input: {
  readonly enabled: boolean;
  readonly environmentId: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly driver: string;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly model: string | undefined;
  readonly explicit: boolean;
  readonly draftId: string | null;
  readonly select: (instanceId: ProviderInstanceId) => void;
}) {
  const {
    enabled,
    environmentId,
    providers,
    driver,
    currentInstanceId,
    model,
    explicit,
    draftId,
    select,
  } = input;
  // Minute resolution is enough: a window that resets re-ranks within the minute.
  const now = Date.parse(`${useNowMinute()}Z`); // the minute is an ISO UTC prefix
  const choice = useMemo(
    () =>
      enabled && environmentId
        ? chooseAutoAccount(
            usableInstances(providers, driver).filter((provider) =>
              provider.models.some((candidate) => candidate.slug === model),
            ),
            (provider) => provider.usageLimits,
            now,
          )
        : null,
    [enabled, environmentId, providers, driver, model, now],
  );
  const appliedRef = useRef<string | null>(null);
  const chosenInstanceId = choice?.account.instanceId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes Auto's account choice into the draft store once per draft and model
  useEffect(() => {
    if (!enabled || !environmentId || explicit || chosenInstanceId === null) return;
    const key = `${draftId}|${environmentId}|${driver}|${model}|${chosenInstanceId}`;
    if (appliedRef.current === key) return;
    appliedRef.current = key;
    if (currentInstanceId !== chosenInstanceId) select(chosenInstanceId);
  }, [
    enabled,
    environmentId,
    explicit,
    draftId,
    driver,
    model,
    chosenInstanceId,
    currentInstanceId,
    select,
  ]);
  return choice;
}

/**
 * New chats move off exhausted defaults on either an automatic or manually
 * chosen machine. Prefer a compatible account, then another pinned model.
 * A model picked by hand in the draft stays picked.
 */
export function useLimitedAccountSwitch(input: {
  readonly draftId: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly currentSelection: ModelSelection | null;
  readonly explicit: boolean;
  readonly select: (selection: ModelSelection) => void;
}) {
  const { draftId, providers, settings, currentSelection, explicit, select } = input;
  const now = Date.parse(`${useNowMinute()}Z`); // the minute is an ISO UTC prefix
  const target = useMemo(() => {
    if (draftId === null || explicit || currentSelection === null) return null;
    const current = providers.find(
      (provider) => provider.instanceId === currentSelection.instanceId,
    );
    if (!current || !accountStanding(current.usageLimits, now).limited) return null;
    const choice = resolveNewChatModelSelection(currentSelection, settings, providers, now);
    return choice !== currentSelection ? choice : null;
  }, [draftId, providers, settings, currentSelection, explicit, now]);
  const appliedRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves a draft off a depleted account in the draft store once per draft
  useEffect(() => {
    if (draftId === null || target === null) return;
    const key = draftId;
    if (appliedRef.current === key) return;
    appliedRef.current = key;
    select(target);
  }, [draftId, target, select]);
}

/** `Claude owner (Max 20x)`: the instance name, with the plan unless the name has one. */
function accountName(provider: ServerProvider, driverLabel: string): string {
  const name = provider.displayName?.trim() || driverLabel;
  const plan = shortPlanLabel(provider.auth.label);
  return plan && !name.includes("(") ? `${name} (${plan})` : name;
}

/** `alice` from "Claude alice (Pro)" or from the signed-in email. */
function accountLogin(provider: ServerProvider): string | null {
  const local = provider.auth.email?.split("@")[0]?.trim();
  if (local) return local;
  const name = provider.displayName?.trim().split(/\s+/)[1];
  return name ?? null;
}

/**
 * The composer's Auto chip text (Owner picked this design on 2026-10-06) and its tooltip, which says what Auto chose
 * and why, e.g. "build-mac: most free memory · Claude alice (Pro): 91% week left".
 */
export function autoPlacementLabel(input: {
  readonly placement: {
    readonly pending: boolean;
    readonly failed: boolean;
    readonly lastChosen: { readonly environmentId: string; readonly reason: string } | null;
  };
  /** The machine the draft is on once Auto resolved, else null. */
  readonly environmentId: string | null;
  readonly environments: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
  readonly driver: ProviderDriverKind;
  readonly account: AccountChoice<ServerProvider> | null;
}): { readonly chip: string; readonly detail: string } {
  const { placement, environmentId } = input;
  const machine =
    environmentId === null
      ? undefined
      : input.environments.find((environment) => environment.environmentId === environmentId);
  if (!machine) {
    const status = placement.pending
      ? "checking machines…"
      : placement.failed
        ? "no eligible machine online"
        : "";
    const chip = status ? `Auto · ${status}` : "Auto";
    return { chip, detail: chip };
  }
  const driverLabel = providerClients.get(input.driver)?.label ?? input.driver;
  // The tightest window is what the account can still spend (a fresh session on a used-up week is not).
  const standing = input.account?.standing;
  const left = standing?.tightestLeft;
  // Which window that is, so "40% week" is not read as the session.
  const leftLabel =
    left === null || left === undefined
      ? null
      : `${Math.round(left)}%${
          left === standing?.sessionLeft
            ? " session"
            : left === standing?.weeklyLeft
              ? " week"
              : left === standing?.monthlyLeft
                ? " month"
                : ""
        }`;
  const machineWhy =
    placement.lastChosen?.environmentId === environmentId
      ? `${machine.label}: ${placement.lastChosen.reason}`
      : machine.label;
  const accountWhy = input.account
    ? `${accountName(input.account.account, driverLabel)}${leftLabel ? `: ${leftLabel} left` : ""}`
    : `no ${driverLabel} account with usage left`;
  const detail = `Auto chose ${machineWhy} · ${accountWhy}`;
  const login = input.account ? accountLogin(input.account.account) : null;
  // The chip names the machine, the account and what its tightest window has left, e.g. "build-mac · alice · 88% week".
  const chip = input.account
    ? [machine.label, login ?? driverLabel, leftLabel].filter(Boolean).join(" · ")
    : `${machine.label} · no ${driverLabel} account`;
  return { chip, detail };
}

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/**
 * ChatView's whole Auto account wiring: applies Auto's account and the limited
 * account switch to the composer, and returns the chip/detail for its line.
 */
export function useComposerAutoAccount(input: {
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly draftId: string | null;
  /** The thread's selection, used while the composer has none of its own. */
  readonly threadModelSelection: ModelSelection | undefined;
  readonly automaticEnvironment: boolean;
  /** The machine Auto resolved the draft onto, else null. */
  readonly autoEnvironmentId: string | null;
  readonly autoEnvironmentProviders: ReadonlyArray<ServerProvider> | undefined;
  readonly environments: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
  readonly placement: Parameters<typeof autoPlacementLabel>[0]["placement"];
  readonly driver: ProviderDriverKind;
  readonly currentInstanceId: ProviderInstanceId | null;
  /** Off while the composer cannot change its model (locked or still hydrating). */
  readonly limitedSwitchEnabled: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly selectModel: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const { composerDraftTarget, threadModelSelection, selectModel } = input;
  const composerModelSelection = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft?.activeProvider
      ? (draft.modelSelectionByProvider[draft.activeProvider] ?? null)
      : null;
  });
  const explicit = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.modelSelectionExplicit === true,
  );
  const autoEnvironmentId = input.automaticEnvironment ? input.autoEnvironmentId : null;
  const selectAutoAccount = useCallback(
    (instanceId: ProviderInstanceId) => {
      const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
      const current =
        (draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : null) ??
        threadModelSelection;
      if (current) selectModel(instanceId, current.model);
    },
    [composerDraftTarget, threadModelSelection, selectModel],
  );
  const account = useAutoAccount({
    enabled: input.automaticEnvironment,
    environmentId: autoEnvironmentId,
    providers: (autoEnvironmentId && input.autoEnvironmentProviders) || NO_PROVIDERS,
    driver: input.driver,
    currentInstanceId: input.currentInstanceId,
    model: composerModelSelection?.model ?? threadModelSelection?.model,
    explicit,
    draftId: input.draftId,
    select: selectAutoAccount,
  });
  const selectLimitedModel = useCallback(
    (selection: ModelSelection) => selectModel(selection.instanceId, selection.model),
    [selectModel],
  );
  useLimitedAccountSwitch({
    draftId:
      !input.limitedSwitchEnabled || (input.automaticEnvironment && !autoEnvironmentId)
        ? null
        : input.draftId,
    providers: input.providers,
    settings: input.settings,
    currentSelection: composerModelSelection ?? threadModelSelection ?? null,
    explicit,
    select: selectLimitedModel,
  });
  return input.automaticEnvironment
    ? autoPlacementLabel({
        placement: input.placement,
        environmentId: autoEnvironmentId,
        environments: input.environments,
        driver: input.driver,
        account,
      })
    : undefined;
}

/**
 * Fork (Owner): with Auto on, the composer uses the account `chooseAutoAccount`
 * picks among the chosen machine's instances of the selected provider, and
 * the composer line says what Auto chose and why.
 */
import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  accountStanding,
  chooseAutoInstance,
  type AccountChoice,
} from "@t3tools/shared/accountChoice";
import { useEffect, useMemo, useRef } from "react";

import { providerClients } from "../../components/settings/providerDriverMeta";
import { useNowMinute } from "../../hooks/useNowMinute";
import { shortPlanLabel } from "./planLabel";

/**
 * Applies the Auto account to the draft once per machine/driver/choice, so
 * a user who then picks another account in the model picker keeps it until
 * Auto's answer changes.
 */
export function useAutoAccount(input: {
  readonly enabled: boolean;
  readonly environmentId: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly driver: string;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly select: (instanceId: ProviderInstanceId) => void;
}) {
  const { enabled, environmentId, providers, driver, currentInstanceId, select } = input;
  // Minute resolution is enough: a window that resets re-ranks within the minute.
  const now = Date.parse(`${useNowMinute()}Z`); // the minute is an ISO UTC prefix
  const choice = useMemo(
    () => (enabled && environmentId ? chooseAutoInstance(providers, driver, now) : null),
    [enabled, environmentId, providers, driver, now],
  );
  const appliedRef = useRef<string | null>(null);
  const chosenInstanceId = choice?.account.instanceId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes Auto's account choice into the draft store once per draft and model
  useEffect(() => {
    if (!enabled || !environmentId || chosenInstanceId === null) return;
    const key = `${environmentId}|${driver}|${chosenInstanceId}`;
    if (appliedRef.current === key) return;
    appliedRef.current = key;
    if (currentInstanceId !== chosenInstanceId) select(chosenInstanceId);
  }, [enabled, environmentId, driver, chosenInstanceId, currentInstanceId, select]);
  return choice;
}

/**
 * Outside Auto (a machine picked by hand), a new chat still moves off an
 * account with no limit left, once per draft and provider, to the account
 * Auto would pick on that machine. Picking the limited account again by hand
 * then sticks.
 */
export function useLimitedAccountSwitch(input: {
  readonly draftId: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly driver: string;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly select: (instanceId: ProviderInstanceId) => void;
}) {
  const { draftId, providers, driver, currentInstanceId, select } = input;
  const now = Date.parse(`${useNowMinute()}Z`); // the minute is an ISO UTC prefix
  const target = useMemo(() => {
    if (draftId === null || currentInstanceId === null) return null;
    const current = providers.find((provider) => provider.instanceId === currentInstanceId);
    if (!current || !accountStanding(current.usageLimits, now).limited) return null;
    const choice = chooseAutoInstance(providers, driver, now);
    return choice && choice.account.instanceId !== currentInstanceId
      ? choice.account.instanceId
      : null;
  }, [draftId, providers, driver, currentInstanceId, now]);
  const appliedRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves a draft off a depleted account in the draft store once per draft
  useEffect(() => {
    if (draftId === null || target === null) return;
    const key = `${draftId}|${driver}`;
    if (appliedRef.current === key) return;
    appliedRef.current = key;
    select(target);
  }, [draftId, driver, target, select]);
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
 * and why, e.g. "build-mac: most free memory · Claude alice (Pro): 91% left".
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
  const left = input.account?.standing.tightestLeft;
  const machineWhy =
    placement.lastChosen?.environmentId === environmentId
      ? `${machine.label}: ${placement.lastChosen.reason}`
      : machine.label;
  const accountWhy = input.account
    ? `${accountName(input.account.account, driverLabel)}${
        left !== null && left !== undefined ? `: ${Math.round(left)}% left` : ""
      }`
    : `no ${driverLabel} account with usage left`;
  const detail = `Auto chose ${machineWhy} · ${accountWhy}`;
  const login = input.account ? accountLogin(input.account.account) : null;
  // The chip names the machine, the account and what its tightest window has left, e.g. "build-mac · alice · 88%".
  const chip = input.account
    ? [
        machine.label,
        login ?? driverLabel,
        left !== null && left !== undefined ? `${Math.round(left)}%` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : `${machine.label} · no ${driverLabel} account`;
  return { chip, detail };
}

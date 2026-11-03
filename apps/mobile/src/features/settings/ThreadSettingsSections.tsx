import {
  AuthSettingsWriteScope,
  isManagedSettingPath,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  managedSettingReason,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";

export function SettingsLabsRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="Labs">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <MachineBetaSection
          title="Linked environments"
          icon="link"
          capability="peerLinks"
          setting="linkedEnvironmentsEnabled"
          description="Let agents on a machine work on your other machines, and theirs on it. Turn it on for each machine. While off, nothing new starts over a link; running tasks finish."
        />
        <MachineBetaSection
          title="Fast worktree checkout"
          icon="bolt.circle"
          capability="fastWorktreeCheckout"
          setting="fastWorktreeCheckout"
          description="On a Mac, clone new worktrees from a checkout cached in the T3 home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache."
        />
      </ScrollView>
    </SettingsScreen>
  );
}

/**
 * Usage-limit rows. The Threads page owns their writes, so they share its queue with the page's
 * other settings. They are environment-wide, so a project selection has nothing to show here.
 */
export function UsageLimitSettingsRows(props: {
  readonly write: (patch: ServerSettingsPatch) => void;
  readonly pending: boolean;
}) {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;

  const projectMembers = projectSelected
    ? (selectedProject?.members.map((member) => member.project) ?? [])
    : null;
  const displayTargets = resolveMobileSettingsTargets(
    selectedTargets.filter(supportsSharedSettingsSync),
    projectMembers,
  );
  // The page saves to all its targets, so any read-only one blocks the save.
  const canWriteSettings =
    displayTargets.length > 0 &&
    resolveMobileSettingsTargets(selectedTargets, projectMembers).every((target) =>
      writableEnvironments.has(target.environment.environmentId),
    );
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (patch: {
    autoResumeLimitedThreads?: boolean;
    snoozeLimitedThreads?: boolean;
    continueLimitedThreadsElsewhere?: boolean;
  }) => props.write(patch);

  const disabled = !canWriteSettings || props.pending;
  const disabledFor = (...keys: string[]) =>
    disabled || managedSettingReason(displayTargets, ...keys) !== undefined;

  return (
    <View className="gap-6">
      {!projectSelected ? (
        <SettingsSection title="Usage limits">
          {/* Fork: the fallback models are chosen in desktop Settings > Threads. */}
          <SettingsSwitchRow
            icon="arrow.triangle.branch"
            label="Continue on another account"
            value={uniformMobileSetting(displayTargets, "continueLimitedThreadsElsewhere")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ continueLimitedThreadsElsewhere: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label="Resume after usage limits"
            subtitle="Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread."
            value={uniformMobileSetting(displayTargets, "autoResumeLimitedThreads")}
            disabled={disabledFor("autoResumeLimitedThreads")}
            onValueChange={(value) => writeToAll({ autoResumeLimitedThreads: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label="Snooze until limits reset"
            subtitle="Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset."
            value={uniformMobileSetting(displayTargets, "snoozeLimitedThreads")}
            disabled={disabledFor("snoozeLimitedThreads")}
            onValueChange={(value) => writeToAll({ snoozeLimitedThreads: value })}
          />
        </SettingsSection>
      ) : null}
    </View>
  );
}

export function WorkingSectionSettings() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const workingShelfEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.workingShelfEnabled !== false;

  return (
    <View className="gap-3">
      <SettingsSection title="Sidebar">
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Working section"
          value={workingShelfEnabled}
          onValueChange={(value) => savePreferences({ workingShelfEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Fold working and monitoring threads into a Working section. They return to the top of the
        list when they need you. While this is on, active threads are ordered by time and cannot be
        moved.
      </Text>
    </View>
  );
}

export function NewThreadSettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const useLastProject =
    AsyncResult.isSuccess(preferences) && preferences.value.useLastProjectForNewThreads !== false;

  return (
    <SettingsSection title="New threads">
      <SettingsSwitchRow
        icon="square.and.pencil"
        label="Use last project"
        subtitle="Start new threads in the last project you used on this device."
        value={useLastProject}
        onValueChange={(value) => savePreferences({ useLastProjectForNewThreads: value })}
      />
    </SettingsSection>
  );
}

type MachineBetaSetting = "linkedEnvironmentsEnabled" | "fastWorktreeCheckout";

/** One switch per connected machine that offers the beta, since each machine's own setting decides. */
function MachineBetaSection({
  title,
  icon,
  capability,
  setting,
  description,
}: {
  readonly title: string;
  readonly icon: ComponentProps<typeof SettingsSwitchRow>["icon"];
  readonly capability: "peerLinks" | "fastWorktreeCheckout";
  readonly setting: MachineBetaSetting;
  readonly description: string;
}) {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities[capability] === true,
  );
  const writable = useEnvironmentsWithScope(supported, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `${setting} beta update`,
    reportFailure: true,
  });
  if (supported.length === 0) return null;
  return (
    <View className="gap-3">
      <SettingsSection title={`Beta: ${title}`}>
        {supported.map((environment) => {
          const policy = environment.serverConfig?.managedPolicy;
          const managed = isManagedSettingPath(policy, setting);
          return (
            <SettingsSwitchRow
              key={environment.environmentId}
              icon={icon}
              label={environment.label}
              {...(managed ? { subtitle: `Managed by ${policy?.organization}.` } : {})}
              value={environment.serverConfig?.settings[setting] === true}
              disabled={managed || !writable.has(environment.environmentId)}
              onValueChange={(value) =>
                void updateSettings({
                  environmentId: environment.environmentId,
                  input: {
                    patch:
                      setting === "linkedEnvironmentsEnabled"
                        ? { linkedEnvironmentsEnabled: value }
                        : { fastWorktreeCheckout: value },
                  },
                })
              }
            />
          );
        })}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">{description}</Text>
    </View>
  );
}

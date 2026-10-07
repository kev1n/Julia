import type { ScopedThreadRef } from "@t3tools/contracts";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../components/ui/AppText";
import { EnvironmentMachineSymbol } from "../components/EnvironmentMachineSymbol";
import { SymbolView } from "../components/ui/AppSymbol";
import { useMachineSummaries } from "./machines";
import { useMoveThread } from "./useMoveThread";
import { useSelectWorkspaceDetail } from "../features/layout/workspace/useSelectWorkspaceDetail";

export function ThreadMachineRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onPress: () => void;
}) {
  const move = useMoveThread(props.threadRef);
  return (
    <Pressable
      accessibilityLabel={`Run on ${move.currentLabel}. Change machine`}
      accessibilityRole="button"
      className="mx-4 mb-3 min-h-14 flex-row items-center gap-3 rounded-2xl bg-grouped-card px-4 py-3 active:bg-subtle"
      onPress={props.onPress}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-foreground-muted">Run on</Text>
        <Text className="text-base font-t3-medium text-foreground">{move.currentLabel}</Text>
      </View>
      <SymbolView name="chevron.right" size={16} tintColorClassName="accent-icon-subtle" />
    </Pressable>
  );
}

export function ThreadMachineChoices(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const selectDetail = useSelectWorkspaceDetail();
  const move = useMoveThread(props.threadRef);
  const summaries = useMachineSummaries(true);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" className="flex-1 bg-sheet">
      <View className="gap-3 px-4 py-4">
        <Text className="text-sm text-foreground-muted">
          {move.isMoving
            ? "Moving thread…"
            : (move.disabledReason ??
              "Move this thread with its files and conversation to another machine.")}
        </Text>
        <View className="overflow-hidden rounded-2xl bg-grouped-card">
          <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
            <Text className="min-w-0 flex-1 text-base text-foreground">{move.currentLabel}</Text>
            <SymbolView name="checkmark" size={18} tintColorClassName="accent-icon" />
          </View>
          {move.choices.map((choice) => (
            <Pressable
              key={choice.environmentId}
              accessibilityRole="button"
              accessibilityLabel={`Move thread to ${choice.label}`}
              accessibilityState={{ disabled: move.isMoving || move.disabledReason !== null }}
              disabled={move.isMoving || move.disabledReason !== null}
              className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:bg-subtle disabled:opacity-50"
              onPress={() =>
                void move
                  .move(choice.environmentId, (ref) => {
                    props.onClose();
                    selectDetail({
                      name: "Thread",
                      params: {
                        environmentId: String(ref.environmentId),
                        threadId: String(ref.threadId),
                      },
                    });
                  })
                  .catch((error: unknown) =>
                    Alert.alert(
                      "Move failed",
                      error instanceof Error ? error.message : String(error),
                    ),
                  )
              }
            >
              <EnvironmentMachineSymbol
                kind={choice.machine}
                size={24}
                tintColorClassName="accent-icon"
              />
              <View className="min-w-0 flex-1">
                <Text className="text-base font-t3-medium text-foreground">{choice.label}</Text>
                <Text className="text-xs tabular-nums text-foreground-muted">
                  {summaries.get(choice.environmentId)}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
        {move.choices.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            Connect another machine with this project and provider to move the thread.
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

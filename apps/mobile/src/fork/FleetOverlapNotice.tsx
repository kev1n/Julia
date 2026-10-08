/**
 * Fork (Owner): the phone's overlap suggestion, above the composer. Another
 * live chat has potentially conflicting goals or shared findings; neither agent is messaged.
 * "Review with agent" only adds a prompt to this thread's draft for the user to send.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  fleetOverlapReasons,
  fleetOverlapPrompt,
  fleetOverlapSignature,
  fleetOverlapTitle,
} from "@t3tools/client-runtime/fleet-overlaps";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { SymbolView } from "../components/ui/AppSymbol";
import { appendReviewCommentToDraft } from "../state/use-thread-composer-state";
import { serverEnvironment } from "../state/server";

// Dismissed signatures per thread, for this app session.
const dismissed = new Map<string, string>();

export function FleetOverlapNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigation = useNavigation();
  const [dismissals, setDismissals] = useState(() => new Map(dismissed));
  const result = useAtomValue(
    serverEnvironment.fleetOverlaps({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const overlaps = Option.getOrNull(AsyncResult.value(result))?.overlaps ?? [];
  const [first] = overlaps;
  const key = `${props.environmentId}/${props.threadId}`;
  const signature = fleetOverlapSignature(overlaps);
  if (first === undefined || dismissals.get(key) === signature) return null;
  return (
    <View className="px-4 pb-3">
      <View className="flex-row items-start gap-3 rounded-[20px] border-continuous bg-card p-4">
        <SymbolView
          name="person.2"
          size={16}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-sm text-foreground">{fleetOverlapTitle(overlaps)}</Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {fleetOverlapReasons(overlaps)}
          </Text>
          <View className="flex-row gap-4 pt-1">
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              className="active:opacity-60"
              onPress={() =>
                first.environmentId !== props.environmentId
                  ? void Linking.openURL(first.url)
                  : navigation.getParent()?.navigate("Thread", {
                      environmentId: first.environmentId,
                      threadId: first.threadId,
                    })
              }
            >
              <Text className="text-sm font-medium text-foreground">Open related chat</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              className="active:opacity-60"
              onPress={() =>
                appendReviewCommentToDraft({
                  environmentId: props.environmentId,
                  threadId: props.threadId,
                  text: fleetOverlapPrompt(overlaps),
                })
              }
            >
              <Text className="text-sm font-medium text-foreground">Review with agent</Text>
            </Pressable>
          </View>
        </View>
        <Pressable
          accessibilityLabel="Dismiss until the overlap changes"
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => {
            dismissed.set(key, signature);
            setDismissals(new Map(dismissed));
          }}
          className="p-1 active:opacity-60"
        >
          <SymbolView
            name="xmark"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      </View>
    </View>
  );
}

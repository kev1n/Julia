/**
 * Fork (Owner): the phone's notice for a settled thread whose history is in
 * Azure. Subscribing starts the restore; the notice shows while it runs, and
 * says plainly when the history has expired or Azure could not be reached.
 * The web twin is `apps/web/src/fork/threadHistory/useThreadHistoryBanner.tsx`.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { SymbolView } from "../components/ui/AppSymbol";
import { serverEnvironment } from "../state/server";

export function ThreadHistoryNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const atom = serverEnvironment.threadHistory({
    environmentId: props.environmentId,
    input: { threadId: props.threadId },
  });
  const status = Option.getOrNull(AsyncResult.value(useAtomValue(atom)));
  const retry = useAtomRefresh(atom);
  if (status === null || status.state === "local") return null;
  const settled =
    status.offloadedAt === undefined
      ? ""
      : ` (settled ${new Date(status.offloadedAt).toLocaleDateString()})`;
  const [title, detail] =
    status.state === "restoring"
      ? ["Restoring this thread's history", "It was moved to Azure when the thread settled."]
      : status.state === "expired"
        ? [
            "History expired",
            `Kept 60 days after the thread settled${settled}, then deleted from Azure.`,
          ]
        : ["History unavailable", status.message ?? "Azure could not be reached."];
  return (
    <View className="px-4 pb-3">
      <View className="flex-row items-start gap-3 rounded-[20px] border-continuous bg-card p-4">
        <SymbolView
          name={status.state === "restoring" ? "arrow.clockwise" : "exclamationmark.triangle"}
          size={16}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-sm text-foreground">{title}</Text>
          <Text className="text-xs text-foreground-muted">{detail}</Text>
          {status.state === "unavailable" ? (
            <View className="flex-row pt-1">
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                className="active:opacity-60"
                onPress={retry}
              >
                <Text className="text-sm font-medium text-foreground">Retry</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

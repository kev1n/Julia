import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  visibleSubagentThreadList,
  subagentThreadListStatus,
} from "@t3tools/client-runtime/state/subagent-thread-list";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { environmentThreadShells } from "../../state/threads";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

/** `tabs` is the thread's chat tab strip: the row lists every tab's subagents. */
export function useThreadSubagentList(
  thread: EnvironmentThreadShell,
  tabs: ReadonlyArray<EnvironmentThreadShell>,
) {
  const all = useAtomValue(
    environmentThreadShells.chatSubagentThreadShellsAtom(
      (tabs.length > 0 ? tabs : [thread]).map((tab) => ({
        environmentId: tab.environmentId,
        threadId: tab.id,
      })),
    ),
  );
  const [now, setNow] = useState(Date.now);
  // Native lists recycle row components; another parent must start expanded.
  const key = `${thread.environmentId}:${thread.id}`;
  const [disclosure, setDisclosure] = useState({ key, expanded: true });
  const expanded = disclosure.key !== key || disclosure.expanded;
  const roster = useMemo(() => visibleSubagentThreadList(all, now), [all, now]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer that drops finished subagents from the roster when they expire
  useEffect(() => {
    if (roster.nextExpiry === null) return;
    const expiry = roster.nextExpiry;
    const timer = setTimeout(
      () => setNow(Math.max(expiry, Date.now())),
      Math.max(0, expiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [roster.nextExpiry]);
  return {
    all,
    threads: roster.threads,
    expanded,
    toggle: () => setDisclosure({ key, expanded: !expanded }),
  };
}

export function ThreadSubagentDisclosure(props: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (props.count === 0) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.expanded ? "Collapse" : "Expand"} ${props.count} ${props.count === 1 ? "subagent" : "subagents"}`}
      accessibilityState={{ expanded: props.expanded }}
      className="min-h-[40px] flex-row items-center gap-1 px-2"
      onPress={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
    >
      <Text className="text-xs tabular-nums text-foreground-tertiary">
        {props.count} {props.count === 1 ? "agent" : "agents"}
      </Text>
      <SymbolView name={props.expanded ? "chevron.down" : "chevron.right"} size={10} />
    </Pressable>
  );
}

export function ThreadSubagentRows(props: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  expanded: boolean;
  selectedThreadKey?: string | null;
  onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  if (!props.expanded || props.threads.length === 0) return null;
  return (
    <View className="mr-4 mb-2 ml-9 border-l border-border-subtle pl-2">
      {props.threads.map((thread) => {
        const status = subagentThreadListStatus(thread);
        const selected = props.selectedThreadKey === `${thread.environmentId}:${thread.id}`;
        return (
          <Pressable
            key={thread.id}
            accessibilityRole="button"
            accessibilityLabel={`${thread.title}, ${status}`}
            accessibilityState={{ selected }}
            className={cn(
              "min-h-[40px] flex-row items-center gap-2 rounded-md px-2",
              selected && "bg-surface-elevated",
            )}
            onPress={() => props.onSelectThread(thread)}
          >
            {status === "In progress" ? (
              <ActivityIndicator size="small" />
            ) : (
              <SymbolView
                name={
                  status === "Completed"
                    ? "checkmark"
                    : status === "Failed"
                      ? "exclamationmark.circle"
                      : status === "Approval needed"
                        ? "exclamationmark.triangle"
                        : status === "Input needed"
                          ? "text.bubble"
                          : "stop.fill"
                }
                size={13}
              />
            )}
            <Text className="flex-1 text-sm text-foreground-secondary" numberOfLines={1}>
              {thread.title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

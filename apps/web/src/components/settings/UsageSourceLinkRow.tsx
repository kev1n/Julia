/**
 * Fork: links a provider instance to a usage limit source (a CLIProxyAPI hub) on the same server,
 * so Auto ranks it by the hub's accounts instead of this machine's login. A matching base URL only
 * offers the link; nothing is linked until the user picks it.
 */
import type {
  ProviderInstanceConfig,
  UnifiedSettings,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { T, Var, useGT } from "gt-react";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { suggestedUsageLimitSource } from "./UsageSourceLink.logic";

const NOT_LINKED = "";

export function UsageSourceLinkRow({
  instanceId,
  instance,
  sources,
  readOnly,
  onUpdate,
}: {
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly readOnly: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
}) {
  const gt = useGT();
  const linked = instance.usageLimitSourceId;
  const labelOf = (id: string) => {
    const source = sources[id as UsageLimitSourceId];
    return source ? source.label?.trim() || source.url : gt("{id} (removed)", { id });
  };
  const suggestion = linked ? null : suggestedUsageLimitSource(instance, sources);
  const link = (id: string | null) => {
    const { usageLimitSourceId: _omit, ...rest } = instance;
    onUpdate(id ? { ...rest, usageLimitSourceId: id as UsageLimitSourceId } : rest);
  };
  const ids = Object.keys(sources);
  if (linked && !ids.includes(linked)) ids.push(linked);
  return (
    <SettingsRow
      title={gt("Usage from hub")}
      description={
        suggestion
          ? gt("Requests go to {hub}. Link it so Auto ranks this instance by the hub's accounts.", {
              hub: labelOf(suggestion),
            })
          : gt(
              "Auto ranks a linked instance by its hub's accounts instead of this machine's login.",
            )
      }
      control={
        <div className="flex items-center gap-2">
          {suggestion && !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => link(suggestion)}>
              <T>
                Link <Var>{labelOf(suggestion)}</Var>
              </T>
            </Button>
          ) : null}
          <Select
            value={linked ?? NOT_LINKED}
            disabled={readOnly}
            onValueChange={(value) => {
              if (value === null) return;
              link(value === NOT_LINKED ? null : value);
            }}
          >
            <SelectTrigger
              aria-label={gt("Usage hub for {instanceId}", { instanceId })}
              className="w-44"
              size="sm"
            >
              <SelectValue>{linked ? labelOf(linked) : gt("Not linked")}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={NOT_LINKED}>{gt("Not linked")}</SelectItem>
              {ids.map((id) => (
                <SelectItem key={id} value={id}>
                  {labelOf(id)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

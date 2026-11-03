import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { PlusIcon, ScaleIcon } from "lucide-react";
import { memo } from "react";

import { ADD_TO_MACHINE_LABEL_CLASS, type EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { MachineUsageLine } from "../fork/machines/MachineUsageLine";
import { useMoveThread } from "../fork/moveThread/useMoveThread";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  /** Fork: why Auto chose this machine and account; the tooltip. */
  autoEnvironmentDetail?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  threadRef?: ScopedThreadRef | null;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onAddToMachine?: (() => void) | undefined;
}

// Action values cannot collide with server-minted environment IDs.
const AUTO_VALUE = "action:auto";
const ADD_MACHINE_VALUE = "action:add-machine";
const environmentValue = (id: EnvironmentId) => `env:${id}`;

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  autoEnvironmentDetail,
  onAutoEnvironment,
  envLocked,
  threadRef,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onAddToMachine,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const moveThread = useMoveThread(envLocked ? (threadRef ?? null) : null);
  const canMove = envLocked && moveThread.choices.length > 0;
  const options: readonly Omit<EnvironmentOption, "projectId" | "isPrimary">[] = canMove
    ? [
        {
          environmentId,
          label:
            availableEnvironments.find((env) => env.environmentId === environmentId)?.label ??
            "This machine",
          machine:
            availableEnvironments.find((env) => env.environmentId === environmentId)?.machine ??
            ("server" as const),
        },
        ...moveThread.choices.map((choice) => ({
          environmentId: choice.environmentId,
          label: choice.label,
          machine: choice.machine,
        })),
      ]
    : availableEnvironments;
  const showAddToMachine = !envLocked && onAddToMachine !== undefined;
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.host",
  );
  const activeEnvironment =
    availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;

  const environmentItems = [
    ...(!envLocked && onAutoEnvironment
      ? [{ value: AUTO_VALUE, label: autoEnvironmentLabel ?? "Auto balance" }]
      : []),
    ...options.map((env) => ({
      value: environmentValue(env.environmentId),
      label: `${env.label}${env.detail === "Project setup required" ? " · Set up project" : ""}`,
    })),
    ...(showAddToMachine ? [{ value: ADD_MACHINE_VALUE, label: "Add to another machine" }] : []),
  ];

  // Match the xs control's height and padding: the composer strip has no min-height,
  // and its glass seam assumes that height even when this label is the only control.
  if (
    !canMove &&
    (envLocked || (onEnvironmentChange === undefined && onAddToMachine === undefined))
  ) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        <EnvironmentMachineIcon
          kind={activeEnvironment?.machine ?? "server"}
          className="size-3 shrink-0"
        />
        <ComposerContextLabel>{activeEnvironment?.label ?? "Run on"}</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {envLocked
            ? "Moving requires another connected machine with this project and provider."
            : (activeEnvironment?.label ?? "Run on")}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={!envLocked && autoEnvironmentLabel ? AUTO_VALUE : environmentValue(environmentId)}
      onValueChange={(value) => {
        if (value === ADD_MACHINE_VALUE) {
          onAddToMachine?.();
        } else if (value === AUTO_VALUE) {
          onAutoEnvironment?.();
        } else if (value?.startsWith("env:")) {
          const nextEnvironmentId = value.slice(4) as EnvironmentId;
          if (canMove) {
            const choice = moveThread.choices.find(
              (choice) => choice.environmentId === nextEnvironmentId,
            );
            if (choice) void moveThread.move(choice.menuId);
          } else {
            onEnvironmentChange?.(nextEnvironmentId);
          }
        }
      }}
      disabled={moveThread.isMoving}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {!envLocked && autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          <span className="whitespace-pre-line">
            {canMove
              ? (moveThread.disabledReason ?? "Move this thread to another machine")
              : (autoEnvironmentDetail ??
                autoEnvironmentLabel ??
                activeEnvironment?.label ??
                "Run on")}
          </span>
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>{canMove ? "Move to another machine" : "Run on"}</SelectGroupLabel>
          {canMove && moveThread.disabledReason ? (
            <SelectGroupLabel>{moveThread.disabledReason}</SelectGroupLabel>
          ) : null}
          {!envLocked && onAutoEnvironment && (
            <SelectItem
              value={AUTO_VALUE}
              onClick={() => {
                if (autoEnvironmentLabel) onAutoEnvironment?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoEnvironmentLabel ?? "Auto balance"}
              </span>
            </SelectItem>
          )}
          {options.map((env) => (
            <SelectItem
              key={env.environmentId}
              value={environmentValue(env.environmentId)}
              disabled={
                env.disabled === true ||
                (canMove
                  ? moveThread.disabledReason !== null || env.environmentId === environmentId
                  : onEnvironmentChange === undefined && env.environmentId !== environmentId)
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
              </span>
              {env.detail ? (
                <span className="block text-xs text-muted-foreground">{env.detail}</span>
              ) : null}
              {/* Fork: live CPU, memory and disk while the menu is open. */}
              <MachineUsageLine environmentId={env.environmentId} />
            </SelectItem>
          ))}
          {showAddToMachine ? (
            <SelectItem value={ADD_MACHINE_VALUE}>
              <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                <PlusIcon aria-hidden="true" className="size-3" />
                Add to another machine
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

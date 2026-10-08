import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { useEnvironment, useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { resolveServerConfigVersionMismatch } from "../versionSkew";
import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export interface ServerUpdateReviewTarget extends ServerUpdateTarget {
  readonly serverVersion: string;
}

function ServerUpdateReviewRow({ target }: { target: ServerUpdateReviewTarget }) {
  const environment = useEnvironment(target.environmentId);
  const state = useAtomValue(serverEnvironment.updateStateAtom(target.environmentId));
  const connected = environment?.connection.phase === "connected";
  const updated =
    connected &&
    environment.serverConfig !== null &&
    !resolveServerConfigVersionMismatch(environment.serverConfig);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{target.serverLabel}</p>
        <p className="mt-1 break-all text-xs text-muted-foreground">
          {environment?.serverConfig?.environment.serverVersion ?? target.serverVersion}
          {!updated ? ` → ${target.targetVersion}` : null}
        </p>
        {state.status !== "idle" ? <ServerUpdateProgress state={state} /> : null}
      </div>
      {state.status === "running" ? null : updated ? (
        <span className="text-xs text-muted-foreground">Up to date</span>
      ) : connected ? (
        <ServerUpdateAction
          {...target}
          label={state.status === "failed" ? "Retry update" : "Update"}
        />
      ) : (
        <span className="text-xs text-muted-foreground">Reconnect to update</span>
      )}
    </div>
  );
}

/** Keeps the reviewed machines visible through update disconnects and reconnects. */
export function ServerUpdateReviewDialog({
  open,
  onOpenChange,
  targets,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly targets: ReadonlyArray<ServerUpdateReviewTarget>;
}) {
  const { environments } = useEnvironments();
  const availableTargetsAtom = Atom.make((get) =>
    targets
      .filter((target) => {
        const environment = environments.find(
          (candidate) => candidate.environmentId === target.environmentId,
        );
        return (
          environment?.connection.phase === "connected" &&
          resolveServerConfigVersionMismatch(environment.serverConfig) !== null &&
          get(serverEnvironment.updateStateAtom(target.environmentId)).status !== "running"
        );
      })
      .map((target) => ({
        ...target,
        continueThreadsAfterServerUpdate:
          environments.find((candidate) => candidate.environmentId === target.environmentId)
            ?.serverConfig?.settings.continueThreadsAfterServerUpdate ?? false,
      })),
  );
  const availableTargets = useAtomValue(availableTargetsAtom);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Update T3 Code servers</DialogTitle>
          <DialogDescription>
            These machines run an older version than this client. Update them together or choose
            individual machines below.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {targets.map((target) => (
            <ServerUpdateReviewRow key={target.environmentId} target={target} />
          ))}
        </DialogPanel>
        <DialogFooter>
          <ServerUpdatesAction targets={availableTargets} size="sm" variant="default" />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

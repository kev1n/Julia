import { Toast } from "@base-ui/react/toast";
import { useEffect, useRef, useState } from "react";

import { useEnvironments } from "../state/environments";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "../versionSkew";
import {
  ServerUpdateReviewDialog,
  type ServerUpdateReviewTarget,
} from "./ServerUpdateReviewDialog";
import { ToastProvider, type ThreadToastData } from "./ui/toast";

const toastManager = Toast.createToastManager<ThreadToastData>();

/** One quiet update notice for the app, independent of the selected chat or machine. */
export function ServerUpdateNotice() {
  return (
    <ToastProvider toastManager={toastManager} position="bottom-right" limit={1}>
      <UpdateNotification />
    </ToastProvider>
  );
}

function UpdateNotification() {
  const { environments } = useEnvironments();
  const { add, close, update } = Toast.useToastManager<ThreadToastData>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewTargets, setReviewTargets] = useState<ReadonlyArray<ServerUpdateReviewTarget>>([]);
  const toastId = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows, updates and closes the imperative toast
  useEffect(() => {
    // Derived here, not in render: updating the toast re-renders this component,
    // and a fresh key list each render would re-run the effect without end.
    const pendingKeys = environments.flatMap((environment) => {
      if (environment.connection.phase !== "connected") return [];
      const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
      if (!mismatch) return [];
      const key = buildVersionMismatchDismissalKey(environment.environmentId, mismatch);
      return dismissedKeys.has(key) || isVersionMismatchDismissed(key) ? [] : [key];
    });
    if (pendingKeys.length === 0 || reviewOpen) {
      const previousId = toastId.current;
      toastId.current = null;
      if (previousId !== null) close(previousId);
      return;
    }

    let id = toastId.current;
    const dismiss = () => {
      // Programmatic removal (a server updated/disconnected) is not a dismissal.
      if (id === null || toastId.current !== id) return;
      toastId.current = null;
      for (const key of pendingKeys) dismissVersionMismatch(key);
      setDismissedKeys((previous) => new Set([...previous, ...pendingKeys]));
    };
    const options = {
      title: "Update available",
      timeout: 0,
      onClose: dismiss,
      actionProps: {
        children: "Review",
        onClick: () => {
          setReviewTargets(
            environments.flatMap((environment): ServerUpdateReviewTarget[] => {
              if (environment.connection.phase !== "connected") return [];
              const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
              if (!mismatch) return [];
              return [
                {
                  environmentId: environment.environmentId,
                  serverLabel: environment.label,
                  serverVersion: mismatch.serverVersion,
                  targetVersion: mismatch.clientVersion,
                  selfUpdate: resolveServerSelfUpdateCapability(environment.serverConfig),
                  installation:
                    environment.serverConfig?.environment.capabilities.serverInstallation,
                  desktopAppUpdate: supportsDesktopAppUpdate(environment.serverConfig),
                },
              ];
            }),
          );
          setReviewOpen(true);
        },
      },
      data: { onClose: dismiss },
    };
    if (id === null) {
      id = add(options);
      toastId.current = id;
    } else {
      update(id, options);
    }
  }, [dismissedKeys, environments, reviewOpen, add, close, update]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the imperative toast when the notice unmounts
  useEffect(
    () => () => {
      const id = toastId.current;
      toastId.current = null;
      if (id !== null) close(id);
    },
    [close],
  );

  return (
    <ServerUpdateReviewDialog
      open={reviewOpen}
      onOpenChange={setReviewOpen}
      targets={reviewTargets}
    />
  );
}

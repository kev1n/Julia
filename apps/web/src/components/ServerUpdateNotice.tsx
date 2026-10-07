import { Toast } from "@base-ui/react/toast";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEnvironments } from "../state/environments";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
} from "../versionSkew";
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
  const navigate = useNavigate();
  const toastId = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const pendingKeys = useMemo(
    () =>
      environments.flatMap((environment) => {
        if (environment.connection.phase !== "connected") return [];
        const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
        if (!mismatch) return [];
        const key = buildVersionMismatchDismissalKey(environment.environmentId, mismatch);
        return dismissedKeys.has(key) || isVersionMismatchDismissed(key) ? [] : [key];
      }),
    [environments, dismissedKeys],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows, updates and closes the imperative toast
  useEffect(() => {
    if (pendingKeys.length === 0) {
      const previousId = toastId.current;
      toastId.current = null;
      if (previousId !== null) toastManager.close(previousId);
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
        onClick: () => void navigate({ to: "/settings/connections" }),
      },
      data: { onClose: dismiss },
    };
    if (id === null) {
      id = toastManager.add(options);
      toastId.current = id;
    } else {
      toastManager.update(id, options);
    }
  }, [pendingKeys, navigate]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the imperative toast when the notice unmounts
  useEffect(
    () => () => {
      const id = toastId.current;
      toastId.current = null;
      if (id !== null) toastManager.close(id);
    },
    [],
  );

  return null;
}

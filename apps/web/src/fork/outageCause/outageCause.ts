import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export type OutageCause =
  // The browser itself reports no network.
  | { readonly _tag: "device-offline" }
  // Every other machine this client uses is unreachable too: the shared
  // factor is this device's network (Wi-Fi), not one server.
  | { readonly _tag: "device-network" }
  // Another machine is connected right now, so this device's network works
  // and the unavailable server is the problem.
  | { readonly _tag: "server"; readonly connectedLabel: string }
  // Nothing to compare against.
  | { readonly _tag: "unknown" };

interface OutageEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
}

const UNREACHABLE_PHASES: ReadonlySet<EnvironmentConnectionPhase> = new Set([
  "connecting",
  "reconnecting",
  "offline",
  "error",
]);

function isLoopback(displayUrl: string | null): boolean {
  if (displayUrl === null) return false;
  try {
    const host = new URL(displayUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Says whether an unavailable environment is down because of this device's
 * network or because of that server, by comparing it with the other machines
 * the client is connected to. A server on this device (loopback) stays
 * reachable without a network, so it is not evidence either way.
 */
export function outageCause(input: {
  readonly networkStatus: "unknown" | "offline" | "online";
  readonly unavailableEnvironmentId: EnvironmentId;
  readonly environments: ReadonlyArray<OutageEnvironment>;
}): OutageCause {
  if (input.networkStatus === "offline") return { _tag: "device-offline" };
  const others = input.environments.filter(
    (environment) =>
      environment.environmentId !== input.unavailableEnvironmentId &&
      !isLoopback(environment.displayUrl) &&
      (environment.connection.phase === "connected" ||
        UNREACHABLE_PHASES.has(environment.connection.phase)),
  );
  const connected = others.find((environment) => environment.connection.phase === "connected");
  if (connected) return { _tag: "server", connectedLabel: connected.label };
  return others.length > 0 ? { _tag: "device-network" } : { _tag: "unknown" };
}

/** Banner copy for an environment that is reconnecting or offline. */
export function outageBannerText(
  input: {
    readonly label: string;
    readonly reconnecting: boolean;
    readonly cause: OutageCause;
  },
  resolve: MessageResolver = m,
): { readonly title: string; readonly description: string | null } {
  const label = input.label;
  switch (input.cause._tag) {
    case "device-offline":
      return {
        title: resolve(msg("This device is offline")),
        description: resolve(
          msg("Reconnects to {label} as soon as your network is back.", { label }),
        ),
      };
    case "device-network":
      return {
        title: input.reconnecting
          ? resolve(msg("{label} is reconnecting: your network", { label }))
          : resolve(msg("{label} is offline: your network", { label })),
        description: resolve(
          msg(
            "Every machine is unreachable from this device, so its Wi-Fi or connection dropped. Reconnects on its own when the network is back.",
          ),
        ),
      };
    case "server":
      return {
        title: resolve(msg("{label} isn't responding", { label })),
        description: resolve(
          msg(
            "{connectedLabel} is connected, so your network is fine. The T3 server on {label} may be down or stuck.",
            { connectedLabel: input.cause.connectedLabel, label },
          ),
        ),
      };
    case "unknown":
      return {
        title: input.reconnecting
          ? resolve(msg("{label} is reconnecting", { label }))
          : resolve(msg("{label} is offline", { label })),
        description: null,
      };
  }
}

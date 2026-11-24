/**
 * Fork: with T3CODE_MOBILE_FORK=1 (fork/scripts/build-mobile.sh) the app installs beside the Play
 * Store app under its own package and scheme, with updates from the build Mac's artifacts server
 * (package, scheme and URL from fork.env). Crash reports never get an endpoint (No telemetry).
 */
import type { ExpoConfig } from "expo/config";

export function withForkConfig(
  upstreamConfig: ExpoConfig,
  env: NodeJS.ProcessEnv = process.env,
): ExpoConfig {
  // Observe's native side can dispatch before the JS gate in observe.ts runs; `.invalid` never resolves.
  const config: ExpoConfig = {
    ...upstreamConfig,
    extra: {
      ...upstreamConfig.extra,
      eas: { ...upstreamConfig.extra?.eas, observe: { endpointUrl: "https://observe.invalid" } },
    },
  };
  if (env.T3CODE_MOBILE_FORK !== "1") return config;
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`T3CODE_MOBILE_FORK=1 needs ${name}`);
    return value;
  };
  return {
    ...config,
    name: "Julia",
    scheme: required("T3CODE_MOBILE_SCHEME"),
    android: { ...config.android, package: required("T3CODE_MOBILE_PACKAGE") },
    updates: {
      ...config.updates,
      enabled: true,
      url: required("T3CODE_MOBILE_UPDATES_URL"),
    },
  };
}

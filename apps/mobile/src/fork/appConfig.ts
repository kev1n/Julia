/**
 * Fork: with T3CODE_MOBILE_FORK=1 (fork/scripts/build-mobile.sh) the app installs beside the
 * Play Store app under its own package and scheme, and takes over-the-air updates from the build
 * Mac's artifacts server instead of EAS. The build script passes the package, scheme and update
 * URL from fork.env. Without it the config is upstream's.
 */
import type { ExpoConfig } from "expo/config";

export function withForkConfig(
  config: ExpoConfig,
  env: NodeJS.ProcessEnv = process.env,
): ExpoConfig {
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

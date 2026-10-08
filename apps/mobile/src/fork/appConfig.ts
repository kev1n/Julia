/**
 * Fork (Owner): with T3CODE_MOBILE_OWNER=1 (fork/scripts/build-mobile.sh) the app installs beside
 * the Play Store app under its own package and takes over-the-air updates from build-mac's artifacts
 * server instead of EAS; the build script owns that URL. Without it the config is upstream's.
 */
import type { ExpoConfig } from "expo/config";

export function withOwnerFork(
  config: ExpoConfig,
  env: NodeJS.ProcessEnv = process.env,
): ExpoConfig {
  if (env.T3CODE_MOBILE_OWNER !== "1") return config;
  const updatesUrl = env.T3CODE_MOBILE_UPDATES_URL;
  if (!updatesUrl) throw new Error("T3CODE_MOBILE_OWNER=1 needs T3CODE_MOBILE_UPDATES_URL");
  return {
    ...config,
    name: "Julia",
    scheme: "julia-fork",
    android: { ...config.android, package: "com.example.julia" },
    updates: {
      ...config.updates,
      enabled: true,
      url: updatesUrl,
    },
  };
}

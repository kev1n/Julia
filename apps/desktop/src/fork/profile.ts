import { FORK_DESKTOP_HOME_DIRNAME, FORK_DESKTOP_PROFILE_DIRNAME } from "./identity.ts";

/**
 * The fork keeps its own Chromium profile and desktop state beside the official app's: sharing
 * them would re-encrypt the official app's saved pairings with another app's keychain key.
 * Keyed on the bundle the process runs from, so dev runs and tests keep upstream's paths.
 */
export function isForkDesktopExecutable(execPath: string): boolean {
  return /\/Julia\.app\/Contents\/MacOS\//.test(execPath);
}

export const IS_FORK_APP = isForkDesktopExecutable(process.execPath);

/** Desktop state lives in its own folder in $HOME instead of ~/.t3 (the server's home on this Mac). */
export function forkDesktopHomeDirname(upstream: string): string {
  return IS_FORK_APP ? FORK_DESKTOP_HOME_DIRNAME : upstream;
}

/** The Electron profile directory under Application Support. */
export function forkUserDataDirname(upstream: string): string {
  return IS_FORK_APP ? FORK_DESKTOP_PROFILE_DIRNAME : upstream;
}

/**
 * Fork (Owner): "T3 Code (Owner).app" keeps its own Chromium profile and its
 * own desktop state, beside the official app's. Sharing them would mean
 * reading (and re-encrypting) the official app's saved pairings with another
 * app's keychain key. Keyed on the bundle the process runs from, so dev runs
 * and tests keep upstream's paths.
 */
export const IS_FORK_APP = /\/T3 Code \(Owner\)\.app\//.test(process.execPath);

/** Desktop state lives in ~/.t3-owner-app instead of ~/.t3 (the server's home on this Mac). */
export function forkDesktopHomeDirname(upstream: string): string {
  return IS_FORK_APP ? ".t3-owner-app" : upstream;
}

/** The Electron profile directory under Application Support. */
export function forkUserDataDirname(upstream: string): string {
  return IS_FORK_APP ? "julia-fork" : upstream;
}

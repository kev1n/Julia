import { describe, expect, it } from "vitest";

import { isForkDesktopExecutable } from "./profile";

describe("fork desktop identity", () => {
  it.each([
    "/Applications/Julia.app/Contents/MacOS/Julia",
    "/Applications/T3 Code (Owner).app/Contents/MacOS/T3 Code (Owner)",
    "/Users/owner/Downloads/Julia.app/Contents/MacOS/Julia",
  ])("preserves the fork profile and keychain mode for %s", (path) => {
    expect(isForkDesktopExecutable(path)).toBe(true);
  });

  it.each([
    "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code",
    "/Applications/Julia (Dev).app/Contents/MacOS/Julia",
    "/Applications/Electron.app/Contents/MacOS/Electron",
    "/usr/local/bin/node",
  ])("does not change official or development profile identity for %s", (path) => {
    expect(isForkDesktopExecutable(path)).toBe(false);
  });
});

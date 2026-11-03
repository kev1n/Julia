import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  describe("with a fork release host built in", () => {
    const host = globalThis as { __T3CODE_BUILD_FORK_RELEASE_BASE_URL__?: string };
    beforeEach(() => {
      host.__T3CODE_BUILD_FORK_RELEASE_BASE_URL__ = "https://build-mac.example.ts.net:8444/";
    });
    afterEach(() => {
      delete host.__T3CODE_BUILD_FORK_RELEASE_BASE_URL__;
    });

    it.each([
      "0.0.46-nightly.20261007.2787+fork.dd65a77",
      "0.0.46-nightly.20261007.2787.fork.1791429000+fork.dd65a77",
    ])("downloads fork version %s from the fork release host, not upstream", (version) => {
      const expected = `https://build-mac.example.ts.net:8444/${version}`;
      expect(cliReleaseDownloadBaseUrl(version)).toBe(expected);
      expect(cliReleaseDownloadBaseUrl(version, " ")).toBe(expected);
      expect(cliReleaseDownloadBaseUrl(version, "https://mirror.example/t3/")).toBe(
        `https://mirror.example/t3/v${version}`,
      );
    });

    it("downloads upstream versions from upstream", () => {
      expect(cliReleaseDownloadBaseUrl("0.0.46-nightly.20261007.2787")).toBe(
        "https://github.com/pingdotgg/t3code/releases/download/v0.0.46-nightly.20261007.2787",
      );
    });
  });

  it("downloads a fork version from upstream when no fork host is built in", () => {
    expect(cliReleaseDownloadBaseUrl("0.0.46-nightly.20261007.2787+fork.dd65a77")).toBe(
      "https://github.com/pingdotgg/t3code/releases/download/v0.0.46-nightly.20261007.2787+fork.dd65a77",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});

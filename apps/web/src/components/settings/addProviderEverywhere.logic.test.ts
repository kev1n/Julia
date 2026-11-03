import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeFanOut,
  planProviderFanOut,
  readClaudeLoginUrl,
  readClaudeSetupToken,
  withProviderSecret,
  type FanOutCandidate,
} from "./addProviderEverywhere.logic";

const machine = (id: string, overrides: Partial<FanOutCandidate> = {}): FanOutCandidate => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  connected: true,
  canManageProviders: true,
  instanceIds: new Set(),
  ...overrides,
});

describe("planProviderFanOut", () => {
  it("adds to every other reachable machine and says why the rest were skipped", () => {
    const plan = planProviderFanOut({
      sourceEnvironmentId: EnvironmentId.make("studio-b"),
      instanceId: "claude_work",
      candidates: [
        machine("studio-b"),
        machine("laptop"),
        machine("studio-a", { connected: false }),
        machine("old-laptop", { canManageProviders: false }),
        machine("spare", { instanceIds: new Set(["claude_work"]) }),
      ],
    });
    expect(plan.targets.map((target) => target.label)).toEqual(["laptop"]);
    expect(plan.skipped).toEqual([
      { label: "studio-a", reason: "offline" },
      { label: "old-laptop", reason: "no-permission" },
      { label: "spare", reason: "exists" },
    ]);
  });
});

describe("describeFanOut", () => {
  it("summarizes added, failed and skipped machines in one line", () => {
    expect(
      describeFanOut(["laptop", "studio-a"], ["spare"], [{ label: "studio-b", reason: "offline" }]),
    ).toBe(
      "Also added to laptop and studio-a. Could not add to spare. Skipped studio-b (offline).",
    );
    expect(describeFanOut([], [], [])).toBe("");
  });
});

describe("withProviderSecret", () => {
  it("replaces or removes one variable and keeps the rest", () => {
    const environment = [
      { name: "CURSOR_API_KEY", value: "", sensitive: true, valueRedacted: true },
      { name: "OTHER", value: "x", sensitive: false },
    ];
    expect(withProviderSecret(environment, "CURSOR_API_KEY", " key_2 ")).toEqual([
      { name: "OTHER", value: "x", sensitive: false },
      { name: "CURSOR_API_KEY", value: "key_2", sensitive: true },
    ]);
    expect(withProviderSecret(environment, "CURSOR_API_KEY", "")).toEqual([
      { name: "OTHER", value: "x", sensitive: false },
    ]);
  });
});

describe("readClaudeSetupToken", () => {
  it("finds the printed token through terminal colors", () => {
    const token = `sk-ant-oat01-${"a1_B-".repeat(20)}`;
    expect(
      readClaudeSetupToken(
        `Your OAuth token (valid for 1 year):\r\n\r\n\u001b[1m${token}\u001b[22m\r\n\r\nStore this token securely.`,
      ),
    ).toBe(token);
    expect(readClaudeSetupToken("Paste code here if prompted > ")).toBeNull();
  });
});

describe("readClaudeLoginUrl", () => {
  it("reads the sign-in page out of the terminal hyperlink", () => {
    const url =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz";
    expect(
      readClaudeLoginUrl(
        `Opening browser to sign in…\r\nIf the browser didn't open, visit: \u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\r\nPaste code here if prompted > `,
      ),
    ).toBe(url);
    expect(readClaudeLoginUrl("Opening browser to sign in…")).toBeNull();
  });
});

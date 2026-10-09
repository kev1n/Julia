// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Owns Playwright resources and their idle timer outside the Effect runtime.
import { ASIDE_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

import { openAsideEndpoint } from "../fork/asideBrowser.ts";
import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  /**
   * A path that starts `executable`, such as one that moves Chrome out of the server's cgroup.
   * Released after the whole launch call, since Playwright retries the same path after a glibc race.
   */
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  /** Closes the shared browser once it has held no context for this long. */
  readonly idleBrowserMs?: number;
  readonly onContextClose?: (context: BrowserContext) => void;
  /** Opens a CDP endpoint to Aside's helper; tests replace it. */
  readonly asideEndpoint?: typeof openAsideEndpoint;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private aside: Promise<{ browser: Browser; close: () => Promise<void> }> | undefined;
  private asideDetached = Promise.resolve();
  private asideOpening = 0;
  private readonly asidePages = new Set<Page>();
  private closing: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSharedContexts = 0;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executable = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executable,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(executable: string, start: (executablePath: string) => Promise<A>) {
    let release: (() => Promise<void>) | undefined;
    try {
      const launcher = await this.options.launcher?.(executable);
      release = launcher?.release;
      return await start(launcher?.path ?? executable);
    } catch (cause) {
      throw (await this.options.diagnose?.(executable, cause)) ?? cause;
    } finally {
      await release?.().catch(constVoid);
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async ({ executable, ...options }) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(executable, (executablePath) =>
          chromium.launch({ ...options, executablePath }),
        );
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  private async sharedContext(options?: Parameters<Browser["newContext"]>[0]) {
    clearTimeout(this.idleTimer);
    this.pendingSharedContexts++;
    const launched = this.sharedBrowser();
    try {
      const context = await (await launched).newContext(options);
      context.on("close", () => this.retireWhenIdle(launched));
      return context;
    } finally {
      this.pendingSharedContexts--;
      this.retireWhenIdle(launched);
    }
  }

  private retireWhenIdle(launched: Promise<Browser>) {
    const delay = this.options.idleBrowserMs;
    if (delay === undefined || this.closing || this.pendingSharedContexts > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.retire(launched), delay);
    this.idleTimer.unref();
  }

  private async retire(launched: Promise<Browser>) {
    const browser = await launched.catch(() => undefined);
    if (!browser || this.browser !== launched || this.pendingSharedContexts > 0) return;
    if (browser.contexts().length > 0) return;
    // Cleared first, so a request during the close launches a fresh browser.
    this.browser = undefined;
    await browser.close().catch(constVoid);
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      return this.sharedContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const { executable, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    return this.launch(executable, (executablePath) =>
      chromium.launchPersistentContext(directory, {
        ...options,
        ...contextOptions,
        executablePath,
      }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await this.sharedContext();
    try {
      const page = await context.newPage();
      page.once("close", () => void context.close().catch(constVoid));
      return page;
    } catch (cause) {
      await context.close().catch(constVoid);
      throw cause;
    }
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  /** One connection to Aside, through its helper, shared by every Aside tab. */
  private asideBrowser() {
    if (!this.aside) {
      const connecting = (async () => {
        await this.asideDetached;
        const bridge = await (this.options.asideEndpoint ?? openAsideEndpoint)();
        try {
          const { chromium } = loadPlaywright();
          const browser = await chromium.connectOverCDP(bridge.endpoint, {
            timeout: 15_000,
            noDefaults: true,
          });
          // A listener prevents Playwright from dismissing native dialogs in human tabs.
          // Managed pages also register their own dialog handler for T3's controls.
          browser.contexts()[0]?.on("dialog", constVoid);
          browser.on("disconnected", () => {
            if (this.aside === connecting) this.aside = undefined;
            void bridge.close().catch(constVoid);
          });
          return { browser, close: bridge.close };
        } catch (cause) {
          await bridge.close().catch(constVoid);
          throw cause;
        }
      })();
      this.aside = connecting;
      void connecting.catch(() => {
        if (this.aside === connecting) this.aside = undefined;
      });
    }
    return this.aside;
  }

  /** A new tab in Aside, which keeps its own storage, window, and size. */
  async asidePage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    this.asideOpening++;
    try {
      const { browser } = await this.asideBrowser();
      if (this.closing) throw new Error("The preview browser is closed.");
      const context = browser.contexts()[0];
      if (!context) throw new Error("Aside has no browser window open.");
      const page = await context.newPage();
      this.trackAsidePage(page);
      return page;
    } finally {
      this.asideOpening--;
      this.detachIdleAside();
    }
  }

  /** Only T3-created pages and their popups hold the helper lease, never human tabs. */
  private trackAsidePage(page: Page) {
    if (this.asidePages.has(page) || page.isClosed()) return;
    this.asidePages.add(page);
    page.on("popup", (popup) => this.trackAsidePage(popup));
    page.once("close", () => {
      this.asidePages.delete(page);
      this.detachIdleAside();
    });
  }

  private detachIdleAside() {
    if (this.asideOpening || this.asidePages.size || !this.aside) return;
    const connection = this.aside;
    this.aside = undefined;
    // New callers wait for the old socket to close before claiming the single-client helper.
    this.asideDetached = connection.then((aside) => aside.close()).catch(constVoid);
  }

  async clearProfile(profileId: string) {
    // Aside's storage is Owner's real browser profile; T3 never clears it.
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID || profileId === ASIDE_BROWSER_PROFILE_ID)
      return;
    const key = JSON.stringify([profileId, null]);
    const existing = this.clearing.get(key);
    if (existing) return existing;
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    clearTimeout(this.idleTimer);
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    // Only the connection ends; Aside and its tabs keep running under the helper.
    const aside = await this.aside?.catch(() => undefined);
    await aside?.close().catch(constVoid);
    await this.asideDetached;
    this.contexts.clear();
  }
}

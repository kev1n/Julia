import * as NodeEvents from "node:events";

import { ASIDE_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  connect: vi.fn<BrowserType["connectOverCDP"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "connectOverCDP").mockImplementation(launches.connect);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    newPage: vi.fn(async () => ({ once: vi.fn() })),
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  return {
    created: contexts,
    contexts: () => contexts.filter((context) => !context.isClosed()),
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
};

const makeAsidePage = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    isClosed: () => closed,
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    once: (event: string, listener: () => void) => events.once(event, listener),
    popup: (page: unknown) => events.emit("popup", page),
    close: async () => {
      closed = true;
      events.emit("close");
    },
  };
};

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
});

const withLauncher = () => {
  const release = vi.fn(async () => {});
  return {
    release,
    configuration: {
      ...options(),
      launcher: vi.fn(async (executable: string) => ({ path: `${executable}-launcher`, release })),
    },
  };
};

beforeEach(() => {
  launches.launch.mockReset();
  launches.connect.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
});

describe("ServerBrowserContexts", () => {
  it("closes the shared browser only after it holds no context for the idle period", async () => {
    vi.useFakeTimers();
    try {
      const first = makeBrowser();
      const second = makeBrowser();
      launches.launch
        .mockResolvedValueOnce(first as unknown as Browser)
        .mockResolvedValueOnce(second as unknown as Browser);
      const pool = new ServerBrowserContexts({ ...options(), idleBrowserMs: 10 });
      const agent = await pool.contextFor("default", "agent");
      await pool.scratchPage();
      await agent.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).not.toHaveBeenCalled();
      await first.created[1]!.close();
      await vi.advanceTimersByTimeAsync(9);
      const next = await pool.contextFor("default", "next");
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).not.toHaveBeenCalled();
      await next.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).toHaveBeenCalledOnce();
      await pool.contextFor("default", "later");
      expect(launches.launch).toHaveBeenCalledTimes(2);
      expect(second.newContext).toHaveBeenCalledOnce();
      await pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares Aside's real context and disconnects without closing its tabs or storage", async () => {
    const context = { ...makeContext(), newPage: vi.fn(async () => makeAsidePage()) };
    const events = new NodeEvents.EventEmitter();
    const browser = {
      contexts: () => [context],
      on: (event: string, listener: () => void) => events.on(event, listener),
      close: vi.fn(),
    };
    launches.connect.mockResolvedValue(browser as unknown as Browser);
    const close = vi
      .fn(async () => {})
      .mockImplementationOnce(async () => {
        events.emit("disconnected");
      });
    const asideEndpoint = vi.fn(async () => ({ endpoint: "ws://aside", close }));
    const pool = new ServerBrowserContexts({ ...options(), asideEndpoint });
    await Promise.all([pool.asidePage(), pool.asidePage()]);
    expect(asideEndpoint).toHaveBeenCalledTimes(1);
    expect(context.newPage).toHaveBeenCalledTimes(2);
    expect(launches.connect).toHaveBeenCalledWith("ws://aside", {
      timeout: 15_000,
      noDefaults: true,
    });
    expect(context.on).toHaveBeenCalledWith("dialog", expect.any(Function));
    await pool.clearProfile(ASIDE_BROWSER_PROFILE_ID);
    expect(launches.rm).not.toHaveBeenCalled();
    await pool.close();
    expect(close).toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it("can retry connecting to Aside after setup fails", async () => {
    const context = { ...makeContext(), newPage: vi.fn(async () => makeAsidePage()) };
    const close = vi.fn(async () => {});
    const asideEndpoint = vi.fn(async () => ({ endpoint: "ws://aside", close }));
    launches.connect.mockRejectedValueOnce(new Error("helper unavailable"));
    launches.connect.mockResolvedValueOnce({
      contexts: () => [context],
      on: vi.fn(),
    } as unknown as Browser);
    const pool = new ServerBrowserContexts({ ...options(), asideEndpoint });
    await expect(pool.asidePage()).rejects.toThrow("helper unavailable");
    expect(close).toHaveBeenCalledTimes(1);
    await pool.asidePage();
    expect(asideEndpoint).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("holds the helper for managed popups and detaches after the last page closes", async () => {
    const context = { ...makeContext(), newPage: vi.fn(async () => makeAsidePage()) };
    const closed = Promise.withResolvers<void>();
    const close = vi.fn(async () => closed.resolve());
    launches.connect.mockResolvedValue({
      contexts: () => [context],
      on: vi.fn(),
    } as unknown as Browser);
    const asideEndpoint = vi.fn(async () => ({ endpoint: "ws://aside", close }));
    const pool = new ServerBrowserContexts({ ...options(), asideEndpoint });
    const page = await pool.asidePage();
    const popup = makeAsidePage();
    (page as unknown as ReturnType<typeof makeAsidePage>).popup(popup);
    await page.close();
    expect(close).not.toHaveBeenCalled();
    await popup.close();
    await closed.promise;
    expect(close).toHaveBeenCalledTimes(1);
    await pool.asidePage();
    expect(asideEndpoint).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("does not detach while another Aside page is opening", async () => {
    const second = Promise.withResolvers<Page>();
    const first = makeAsidePage();
    const context = {
      ...makeContext(),
      newPage: vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(second.promise),
    };
    const close = vi.fn(async () => {});
    launches.connect.mockResolvedValue({
      contexts: () => [context],
      on: vi.fn(),
    } as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      asideEndpoint: async () => ({ endpoint: "ws://aside", close }),
    });
    await pool.asidePage();
    const opening = pool.asidePage();
    await first.close();
    expect(close).not.toHaveBeenCalled();
    second.resolve(makeAsidePage() as unknown as Page);
    await opening;
    expect(close).not.toHaveBeenCalled();
    await pool.close();
  });

  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    const started = Promise.withResolvers<void>();
    launches.launch.mockImplementation(() => {
      started.resolve();
      return launch.promise;
    });
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    await started.promise;
    // Playwright may retry the same path until the launch settles.
    expect(release).not.toHaveBeenCalled();
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ executablePath: "/test/chromium-launcher" }),
    );
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.created) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium-launcher" }),
    );
    expect(release).toHaveBeenCalledTimes(2);
    expect(launches.mkdir).toHaveBeenCalledWith("/test/profiles/work%2Fteam", { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("diagnoses a launcher failure against the real executable", async () => {
    const diagnosed = new Error("diagnosed");
    const diagnose = vi.fn(async () => diagnosed);
    const pool = new ServerBrowserContexts({
      ...options(),
      diagnose,
      launcher: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });
    await expect(pool.contextFor("default", "agent")).rejects.toBe(diagnosed);
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("/test/chromium", expect.any(Error));
    expect(launches.launch).not.toHaveBeenCalled();
  });

  it("creates no launcher for a profile whose storage cannot be created", async () => {
    launches.mkdir.mockRejectedValueOnce(new Error("EACCES"));
    const { configuration } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    await expect(pool.contextFor("work/team")).rejects.toThrow("EACCES");
    expect(configuration.launcher).not.toHaveBeenCalled();
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.created[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith("/test/profiles/never-opened", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("waits for the context to close when the same profile is cleared concurrently", async () => {
    const human = makeContext();
    const closed = Promise.withResolvers<void>();
    human.close.mockImplementation(async () => closed.promise);
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work/team");

    const first = pool.clearProfile("work/team");
    const second = pool.clearProfile("work/team");
    const deletionsBeforeClose = launches.rm.mock.calls.length;
    closed.resolve();
    await Promise.all([first, second]);

    expect(deletionsBeforeClose).toBe(0);
    expect(human.close).toHaveBeenCalledTimes(1);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { T3CODE_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.created[0]?.close).toHaveBeenCalled();
  });
});

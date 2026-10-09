import type { CDPSession, Page } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import { captureViewport, nativeViewport, snapshot } from "./ServerBrowserPage.ts";

describe("native browser captures", () => {
  const pngOf = (imageWidth: number, imageHeight: number) => {
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png);
    png.writeUInt32BE(imageWidth, 16);
    png.writeUInt32BE(imageHeight, 20);
    return png.toString("base64");
  };
  const fixture = (
    width: number,
    height: number,
    density: number,
    imageWidth: number,
    imageHeight: number,
    zoom = 1,
  ) => {
    // Snapshots read form fields through an isolated world in each frame.
    const frameReads: Record<string, unknown> = {
      "Page.getFrameTree": { frameTree: { frame: { id: "main" } } },
      "Page.createIsolatedWorld": { executionContextId: 1 },
      "Runtime.evaluate": { result: { value: [] } },
      // The page shrinks an oversized capture; this stands in for its canvas.
      "Runtime.callFunctionOn": { result: { value: pngOf(1280, 640) } },
    };
    const send = vi.fn(async (method: string, params?: { readonly expression?: string }) =>
      method === "Runtime.evaluate" && params?.expression?.includes("devicePixelRatio")
        ? { result: { value: { ratio: density * zoom, width, height } } }
        : method in frameReads
          ? frameReads[method]
          : method === "Page.getLayoutMetrics"
            ? {
                visualViewport: { clientWidth: width * zoom },
                cssVisualViewport: {
                  pageX: 12,
                  pageY: 34,
                  clientWidth: width,
                  clientHeight: height,
                  zoom,
                },
              }
            : { data: pngOf(imageWidth, imageHeight) },
    );
    const mainFrame = { parentFrame: () => null };
    const page = {
      on: vi.fn(),
      frames: () => [mainFrame],
      mainFrame: () => mainFrame,
      viewportSize: () => null,
      evaluate: vi.fn(async () => ({
        url: "https://example.com",
        title: "Native",
        loading: false,
        visibleText: "",
        interactiveElements: [],
      })),
      ariaSnapshot: vi.fn(async () => ""),
    } as unknown as Page;
    return { page, cdp: { send } as unknown as CDPSession, send };
  };

  it("scales the entire native viewport rather than cropping it to 1280×800", async () => {
    const { page, cdp, send } = fixture(2000, 1000, 1.5, 3000, 1500);
    const result = await snapshot({
      page,
      cdp,
      renderScale: "display",
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png" });
    expect(send).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({ arguments: [expect.anything(), { value: 1280 }, { value: 640 }] }),
    );
    expect(result.screenshot).toMatchObject({ width: 1280, height: 640 });
  });

  it("reports encoded image dimensions instead of assuming fixed 2× density", async () => {
    const { page, cdp, send } = fixture(600, 400, 1, 599, 399);
    const result = await snapshot({
      page,
      cdp,
      renderScale: "display",
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png" });
    expect(result.screenshot).toMatchObject({ width: 599, height: 399 });
  });

  // Captures never pass a clip scale (it mirrors the page into `backdrop-filter`s), so a native
  // page's size comes from its own CSS viewport instead of an emulated one.
  it("native stills capture unclipped and size from the CSS viewport at native zoom", async () => {
    const { cdp, send } = fixture(400, 300, 4, 800, 600, 2);
    await captureViewport(cdp, { format: "jpeg", quality: 70 });
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    expect(await nativeViewport(cdp)).toEqual({ width: 400, height: 300 });
  });
});

import { describe, expect, it } from "vite-plus/test";
import { asideCdpFilter } from "./asideCdpFilter.ts";

const fixture = () => {
  const sent: Array<{ id: number; method: string; sessionId?: string; params?: unknown }> = [];
  const delivered: Array<{ id?: number; method?: string; params?: { sessionId?: string } }> = [];
  const filter = asideCdpFilter(
    (raw) => sent.push(JSON.parse(raw)),
    (raw) => delivered.push(JSON.parse(raw)),
  );
  const attached = (
    targetId: string,
    sessionId: string,
    openerId?: string,
    parentSession?: string,
    type = "page",
  ) =>
    filter.fromHelper(
      JSON.stringify({
        method: "Target.attachedToTarget",
        sessionId: parentSession,
        params: { sessionId, waitingForDebugger: true, targetInfo: { targetId, type, openerId } },
      }),
    );
  const create = (id = 1) => {
    filter.fromPlaywright(
      JSON.stringify({ id, method: "Target.createTarget", params: { url: "about:blank" } }),
    );
    return sent.at(-1)!.id;
  };
  const reply = (id: number, targetId: string) =>
    filter.fromHelper(JSON.stringify({ id, result: { targetId } }));
  return { filter, sent, delivered, attached, create, reply };
};

describe("Aside CDP target ownership", () => {
  it("rejects unsupported requests promptly without forwarding them to Aside", () => {
    const f = fixture();
    f.filter.fromPlaywright('{"id":10,"method":"Page.enable","sessionId":"unknown"}');
    f.filter.fromPlaywright(
      '{"id":11,"method":"Target.attachToTarget","params":{"targetId":"human"}}',
    );
    expect(f.sent).toHaveLength(0);
    expect(f.delivered).toEqual([
      {
        id: 10,
        sessionId: "unknown",
        error: { code: -32000, message: "This CDP session or target is not managed by T3." },
      },
      {
        id: 11,
        error: { code: -32000, message: "This CDP session or target is not managed by T3." },
      },
    ]);
  });

  it("connects without initializing frozen human tabs and resumes/detaches them", () => {
    const f = fixture();
    f.filter.fromPlaywright('{"id":1,"method":"Target.setAutoAttach"}');
    const request = f.sent[0]!;
    expect(request.id).toBeLessThan(1_000_000_000);
    expect(request.id).toBeGreaterThan(1);
    f.attached("human", "frozen");
    f.filter.fromHelper(JSON.stringify({ id: request.id, result: {} }));
    expect(f.delivered).toEqual([{ id: 1, result: {} }]);
    expect(f.sent.slice(1).map((message) => message.method)).toEqual([
      "Runtime.runIfWaitingForDebugger",
      "Target.detachFromTarget",
    ]);
    // Neither a native dialog nor a late old-client response can reach Playwright.
    f.filter.fromHelper('{"method":"Page.javascriptDialogOpening","sessionId":"frozen"}');
    f.filter.fromHelper('{"id":1,"result":{"stale":true}}');
    expect(f.delivered).toHaveLength(1);
  });

  it("opens T3's tabs alone in an inactive window, so streaming them never activates Aside", () => {
    const f = fixture();
    f.create(12);
    expect(f.sent.at(-1)).toMatchObject({
      method: "Target.createTarget",
      params: { url: "about:blank", newWindow: true, background: true },
    });
  });

  it("admits only the confirmed createTarget, before its reply, even with a concurrent human tab", () => {
    const f = fixture();
    const create = f.create(12);
    f.attached("human", "human-session");
    f.attached("ours", "ours-session");
    expect(f.delivered).toHaveLength(0);
    f.reply(create, "ours");
    expect(f.delivered.map((message) => message.method ?? message.id)).toEqual([
      "Target.attachedToTarget",
      12,
    ]);
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        method: "Target.detachFromTarget",
        params: { sessionId: "human-session" },
      }),
    );
    f.filter.fromPlaywright('{"id":13,"method":"Page.enable","sessionId":"ours-session"}');
    const request = f.sent.at(-1)!;
    f.filter.fromHelper(JSON.stringify({ id: request.id, sessionId: "ours-session", result: {} }));
    expect(f.delivered.at(-1)).toMatchObject({ id: 13, sessionId: "ours-session" });
  });

  it("keeps concurrent creations separate and rejects their unrelated pending targets on failure", () => {
    const f = fixture();
    const first = f.create(1);
    const second = f.create(2);
    f.attached("ours1", "s1");
    f.attached("ours2", "s2");
    f.attached("human", "h");
    f.reply(second, "ours2");
    expect(f.delivered[0]?.params?.sessionId).toBe("s2");
    expect(f.sent.filter((message) => message.method === "Target.detachFromTarget")).toHaveLength(
      0,
    );
    f.filter.fromHelper(JSON.stringify({ id: first, error: { message: "creation failed" } }));
    expect(f.sent.filter((message) => message.method === "Target.detachFromTarget")).toHaveLength(
      2,
    );
  });

  it("admits popups, child sessions and extra CDP sessions only for managed targets", () => {
    const f = fixture();
    const request = f.create();
    f.attached("ours", "main");
    f.reply(request, "ours");
    f.attached("popup", "popup-session", "ours");
    f.attached("worker", "worker-session", undefined, "main", "worker");
    f.attached("human-new", "human-new-session");
    expect(
      f.delivered
        .filter((message) => message.method === "Target.attachedToTarget")
        .map((message) => message.params?.sessionId),
    ).toEqual(["main", "popup-session", "worker-session"]);
    f.filter.fromPlaywright('{"id":6,"method":"Target.attachToBrowserTarget"}');
    const browserRequest = f.sent.at(-1)!;
    f.attached("browser", "browser-session", undefined, undefined, "browser");
    f.filter.fromHelper(
      JSON.stringify({ id: browserRequest.id, result: { sessionId: "browser-session" } }),
    );
    f.filter.fromPlaywright(
      '{"id":7,"method":"Target.attachToTarget","sessionId":"browser-session","params":{"targetId":"ours","flatten":true}}',
    );
    const extra = f.sent.at(-1)!;
    f.attached("ours", "extra", undefined, "browser-session");
    f.filter.fromHelper(JSON.stringify({ id: extra.id, result: { sessionId: "extra" } }));
    f.filter.fromPlaywright('{"id":8,"method":"Page.startScreencast","sessionId":"extra"}');
    expect(f.sent.at(-1)).toMatchObject({ method: "Page.startScreencast", sessionId: "extra" });
    f.filter.fromHelper(
      '{"method":"Target.detachedFromTarget","sessionId":"browser-session","params":{"sessionId":"extra"}}',
    );
    f.attached("later-popup", "later-popup-session", "ours");
    expect(f.delivered.at(-1)?.params?.sessionId).toBe("later-popup-session");
  });
});

// @effect-diagnostics nodeBuiltinImport:off - Pure CDP transport allocates independent wire ids outside the Effect runtime.
import * as NodeCrypto from "node:crypto";

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: {
    sessionId?: string;
    targetId?: string;
    waitingForDebugger?: boolean;
    targetInfo?: { targetId: string; type: string; subtype?: string; openerId?: string };
  };
  result?: { targetId?: string; sessionId?: string };
  error?: unknown;
}

/** Only T3-created targets reach Playwright; a frozen human tab cannot block its handshake. */
export const asideCdpFilter = (send: (raw: string) => void, deliver: (raw: string) => void) => {
  const sessions = new Set<string>();
  const browserSessions = new Set<string>();
  const targets = new Map<string, Set<string>>();
  const pending = new Map<string, CdpMessage>();
  const requests = new Map<
    number,
    { original: CdpMessage | undefined; method: string | undefined }
  >();
  // CDP ids are signed 32-bit integers. Stay below the helper's billion-range ids.
  // A random starting point also separates late replies from the older helper.
  let nextId = NodeCrypto.randomInt(10_000_000, 900_000_000);
  let creating = 0;
  const write = (message: CdpMessage, original?: CdpMessage) => {
    const id = ++nextId;
    requests.set(id, { original, method: message.method });
    send(JSON.stringify({ ...message, id }));
  };
  const reject = (message: CdpMessage) => {
    const sessionId = message.params?.sessionId;
    if (!sessionId) return;
    if (message.params?.waitingForDebugger)
      write({ method: "Runtime.runIfWaitingForDebugger", sessionId });
    // Don't await the renderer: a frozen target may never answer the resume request.
    write({
      method: "Target.detachFromTarget",
      params: { sessionId },
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    });
  };
  const admit = (message: CdpMessage) => {
    const sessionId = message.params?.sessionId;
    const info = message.params?.targetInfo;
    if (!sessionId || !info) return;
    sessions.add(sessionId);
    if (info.type === "browser") {
      browserSessions.add(sessionId);
      deliver(JSON.stringify(message));
      return;
    }
    const attached = targets.get(info.targetId) ?? new Set<string>();
    attached.add(sessionId);
    targets.set(info.targetId, attached);
    deliver(JSON.stringify(message));
  };
  const parse = (raw: string): CdpMessage | undefined => {
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === "object" && value !== null ? (value as CdpMessage) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    fromPlaywright(raw: string) {
      const message = parse(raw);
      if (!message) return;
      if (
        (message.sessionId && !sessions.has(message.sessionId)) ||
        (message.method === "Target.attachToTarget" &&
          (!message.params?.targetId || !targets.has(message.params.targetId)))
      ) {
        if (message.id !== undefined)
          deliver(
            JSON.stringify({
              id: message.id,
              ...(message.sessionId ? { sessionId: message.sessionId } : {}),
              error: { code: -32000, message: "This CDP session or target is not managed by T3." },
            }),
          );
        return;
      }
      if (message.id === undefined) {
        send(raw);
        return;
      }
      if (!message.sessionId && message.method === "Target.createTarget") creating++;
      write(message, message);
    },
    fromHelper(raw: string) {
      const message = parse(raw);
      if (!message) return;
      if (message.id !== undefined) {
        const request = requests.get(message.id);
        if (!request) return;
        requests.delete(message.id);
        const original = request.original;
        if (!original) return;
        if (!original.sessionId && request.method === "Target.createTarget") {
          creating--;
          const targetId = message.result?.targetId;
          for (const [sessionId, attachment] of pending) {
            if (attachment.params?.targetInfo?.targetId === targetId) {
              pending.delete(sessionId);
              // Playwright needs the attach event before it receives createTarget's reply.
              admit(attachment);
            } else if (!creating) {
              pending.delete(sessionId);
              reject(attachment);
            }
          }
        }
        if (message.result?.sessionId && original.method === "Target.attachToBrowserTarget") {
          sessions.add(message.result.sessionId);
          browserSessions.add(message.result.sessionId);
        }
        if (
          message.result?.sessionId &&
          original.method === "Target.attachToTarget" &&
          original.params?.targetId &&
          targets.has(original.params.targetId)
        )
          sessions.add(message.result.sessionId);
        if (message.sessionId && !sessions.has(message.sessionId)) return;
        deliver(JSON.stringify({ ...message, id: original.id }));
        return;
      }
      if (message.method === "Target.attachedToTarget") {
        const info = message.params?.targetInfo;
        const sessionId = message.params?.sessionId;
        if (!info || !sessionId) return;
        if (
          (info.type === "browser" &&
            [...requests.values()].some(
              (request) => request.original?.method === "Target.attachToBrowserTarget",
            )) ||
          (message.sessionId &&
            sessions.has(message.sessionId) &&
            !browserSessions.has(message.sessionId)) ||
          targets.has(info.targetId) ||
          (!message.sessionId &&
            info.type === "page" &&
            !info.subtype &&
            info.openerId &&
            targets.has(info.openerId))
        )
          admit(message);
        else if (!message.sessionId && info.type === "page" && !info.subtype && creating)
          pending.set(sessionId, message);
        else reject(message);
        return;
      }
      if (message.sessionId && !sessions.has(message.sessionId)) return;
      if (message.method === "Target.detachedFromTarget") {
        const detached = message.params?.sessionId;
        if (!detached || !sessions.delete(detached)) return;
        browserSessions.delete(detached);
        for (const [targetId, attached] of targets) {
          attached.delete(detached);
          if (!attached.size) targets.delete(targetId);
        }
      }
      deliver(raw);
    },
  };
};

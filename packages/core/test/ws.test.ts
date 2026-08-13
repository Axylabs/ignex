/**
 * WebSocket depth tests: `IgnexWS` send semantics, `createWSHandler` event
 * wiring (with a single wrapper instance per socket), `upgradeWS` data
 * resolution, and the live-connection registry.
 */
import { describe, expect, it, vi } from "vitest";
import type { IgnexContext } from "../src/index.js";
import {
  createWSConnections,
  createWSHandler,
  IgnexWS,
  upgradeWS,
  type WSLocalHook,
} from "../src/index.js";
import type { ServerWebSocket } from "../src/types/index.js";

/** Minimal structural fake of Bun's ServerWebSocket (the subset IgnexWS uses). */
const fakeSocket = (data: unknown = {}) => {
  const sent: unknown[] = [];
  const socket = {
    data,
    sent,
    send: (d: unknown) => {
      sent.push(d);
      return 1;
    },
    sendText: (d: unknown) => {
      sent.push(d);
      return 1;
    },
    sendBinary: (d: unknown) => {
      sent.push(d);
      return 1;
    },
    close: () => {},
    terminate: () => {},
    ping: () => 1,
    pong: () => 1,
    publish: () => 1,
    subscribe: () => {},
    unsubscribe: () => {},
    isSubscribed: () => false,
    cork: <T>(cb: (ws: unknown) => T): T => cb(socket),
    remoteAddress: "203.0.113.7",
    readyState: 1,
    subscriptions: [],
  } as unknown as ServerWebSocket<unknown>;
  return { socket, sent };
};

const makeCtx = (server: unknown) =>
  ({ req: new Request("http://x/"), server }) as unknown as IgnexContext;

describe("IgnexWS.send", () => {
  it("passes strings and binary through verbatim", () => {
    const { socket, sent } = fakeSocket();
    const ws = new IgnexWS(socket, {}, undefined);
    ws.send("hi");
    ws.send(new Uint8Array([1, 2]));
    expect(sent[0]).toBe("hi");
    expect(sent[1]).toEqual(new Uint8Array([1, 2]));
  });

  it("JSON-stringifies plain objects and sendJson is explicit", () => {
    const { socket, sent } = fakeSocket();
    const ws = new IgnexWS(socket, {}, undefined);
    ws.send({ a: 1 });
    ws.sendJson({ b: 2 });
    expect(sent[0]).toBe('{"a":1}');
    expect(sent[1]).toBe('{"b":2}');
  });
});

describe("createWSHandler", () => {
  it("delivers the same IgnexWS instance across open/message/close", () => {
    let inMessage: unknown;
    let inClose: unknown;
    const hook: WSLocalHook = {
      open(ws) {
        (ws as unknown as { tag: number }).tag = 7;
      },
      message(ws) {
        inMessage = (ws as unknown as { tag: number }).tag;
      },
      close(ws) {
        inClose = (ws as unknown as { tag: number }).tag;
      },
    };
    const handler = createWSHandler(hook);
    const { socket } = fakeSocket();

    handler.open?.(socket);
    handler.message?.(socket, "x");
    handler.close?.(socket, 1000, "done");

    expect(inMessage).toBe(7);
    expect(inClose).toBe(7);
  });

  it("auto-parses JSON text messages and keeps non-JSON as strings", () => {
    const messages: unknown[] = [];
    const handler = createWSHandler({ message: (_ws, message) => messages.push(message) });
    const { socket } = fakeSocket();

    handler.message?.(socket, '{"a":1}');
    handler.message?.(socket, "not-json");
    handler.message?.(socket, "42");

    expect(messages).toEqual([{ a: 1 }, "not-json", 42]);
  });
});

describe("upgradeWS", () => {
  it("merges a static hook.upgrade object over options.data", () => {
    const upgrade = vi.fn(() => true);
    const ctx = makeCtx({ upgrade, requestIP: () => null });

    const ok = upgradeWS(ctx, { upgrade: { role: "admin" } }, { data: { user: "ada" } });

    expect(ok).toBe(true);
    expect(upgrade).toHaveBeenCalledWith(ctx.req, { data: { user: "ada", role: "admin" } });
  });

  it("lets a function hook.upgrade fully own the socket data", () => {
    const upgrade = vi.fn(() => true);
    const ctx = makeCtx({ upgrade, requestIP: () => null });

    const ok = upgradeWS(ctx, { upgrade: (c) => ({ from: c.req.url }) }, { data: { ignored: 1 } });

    expect(ok).toBe(true);
    expect(upgrade).toHaveBeenCalledWith(ctx.req, { data: { from: "http://x/" } });
  });

  it("passes headers through and omits data when unresolved", () => {
    const upgrade = vi.fn(() => true);
    const ctx = makeCtx({ upgrade, requestIP: () => null });

    upgradeWS(ctx, {}, { headers: { "x-extra": "1" } });

    expect(upgrade).toHaveBeenCalledWith(ctx.req, { headers: { "x-extra": "1" } });
  });

  it("returns false when the server has no upgrade path", () => {
    expect(upgradeWS(makeCtx(null), {})).toBe(false);
    expect(upgradeWS(makeCtx({ requestIP: () => null }), {})).toBe(false);
  });
});

describe("createWSConnections", () => {
  it("tracks add/has/delete/size and clears", () => {
    const connections = createWSConnections<unknown, unknown, unknown>();
    const { socket: s1 } = fakeSocket();
    const { socket: s2 } = fakeSocket();
    const w1 = new IgnexWS(s1, {}, undefined);
    const w2 = new IgnexWS(s2, {}, undefined);

    connections.add(w1);
    connections.add(w2);
    expect(connections.size).toBe(2);
    expect(connections.has(w1)).toBe(true);

    connections.delete(w1);
    expect(connections.size).toBe(1);
    expect(connections.has(w1)).toBe(false);

    connections.clear();
    expect(connections.size).toBe(0);
  });

  it("broadcasts to every connected socket (text + JSON)", () => {
    const connections = createWSConnections<unknown, unknown, unknown>();
    const a = fakeSocket();
    const b = fakeSocket();
    connections.add(new IgnexWS(a.socket, {}, undefined));
    connections.add(new IgnexWS(b.socket, {}, undefined));

    connections.broadcast("hi");
    expect(a.sent).toEqual(["hi"]);
    expect(b.sent).toEqual(["hi"]);

    connections.broadcastJson({ n: 1 });
    expect(a.sent[1]).toBe('{"n":1}');
    expect(b.sent[1]).toBe('{"n":1}');
  });

  it("auto-registers sockets through createWSHandler and removes them on close", () => {
    const connections = createWSConnections<unknown, unknown, unknown>();
    const handler = createWSHandler({}, connections);
    const a = fakeSocket();
    const b = fakeSocket();

    handler.open?.(a.socket);
    handler.open?.(b.socket);
    expect(connections.size).toBe(2);

    connections.broadcast("hello");
    expect(a.sent).toEqual(["hello"]);
    expect(b.sent).toEqual(["hello"]);

    handler.close?.(a.socket, 1000, "");
    expect(connections.size).toBe(1);

    connections.broadcast("again");
    expect(a.sent).toEqual(["hello"]); // removed — no new message
    expect(b.sent).toEqual(["hello", "again"]);
  });
});

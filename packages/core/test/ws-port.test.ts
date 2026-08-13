/**
 * @fileoverview Port of Elysia `test/ws/*` (unit layer) — the full `IgnexWS`
 * method surface, message dispatch (binary passthrough), publish/subscribe,
 * and error containment on the fake-socket unit path. Real-socket
 * concurrency/backpressure scenarios live in the app E2E matrix.
 */

import type { IgnexContext } from "@ignex/core";
import { createWSConnections, createWSHandler, IgnexWS } from "@ignex/core";
import { describe, expect, it } from "vitest";
import type { ServerWebSocket } from "../src/types/index.js";

const fakeSocket = (data: unknown = {}) => {
  const sent: unknown[] = [];
  const subbed = new Set<string>();
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
    close: () => {
      sent.push("__close__");
    },
    terminate: () => {
      sent.push("__terminate__");
    },
    ping: (d?: unknown) => {
      sent.push(["ping", d]);
      return 1;
    },
    pong: (d?: unknown) => {
      sent.push(["pong", d]);
      return 1;
    },
    publish: (topic: string, d: unknown) => {
      sent.push(["publish", topic, d]);
      return 1;
    },
    publishBinary: (topic: string, d: unknown) => {
      sent.push(["publishBinary", topic, d]);
      return 1;
    },
    publishText: (topic: string, d: unknown) => {
      sent.push(["publishText", topic, d]);
      return 1;
    },
    subscribe: (t: string) => void subbed.add(t),
    unsubscribe: (t: string) => void subbed.delete(t),
    isSubscribed: (t: string) => subbed.has(t),
    cork: <T>(cb: (ws: unknown) => T): T => cb(socket),
    remoteAddress: "198.51.100.9",
    readyState: 1,
    subscriptions: [] as string[],
  } as unknown as ServerWebSocket<unknown>;
  return { socket, sent };
};

const makeCtx = (server: unknown) =>
  ({ req: new Request("http://x/"), server }) as unknown as IgnexContext;

describe("IgnexWS full surface", () => {
  it("sendText / sendBinary route to the raw methods verbatim", () => {
    const { socket, sent } = fakeSocket();
    const ws = new IgnexWS(socket, {}, undefined);
    ws.sendText("t");
    ws.sendBinary(new Uint8Array([9]));
    expect(sent[0]).toBe("t");
    expect(sent[1]).toEqual(new Uint8Array([9]));
  });

  it("publish passes strings/binary through and JSON-stringifies objects", () => {
    const { socket, sent } = fakeSocket();
    const ws = new IgnexWS(socket, {}, undefined);
    ws.publish("room", "hi");
    ws.publish("room", new Uint8Array([1]));
    ws.publish("room", { a: 1 });
    expect(sent[0]).toEqual(["publish", "room", "hi"]);
    // A Uint8Array goes out as raw bytes via publishBinary — never corrupted
    // into a JSON object.
    expect(sent[1]).toEqual(["publishBinary", "room", new Uint8Array([1])]);
    expect(sent[2]).toEqual(["publish", "room", '{"a":1}']);
  });

  it("subscribe / unsubscribe / isSubscribed delegate to the raw socket", () => {
    const { socket } = fakeSocket();
    const ws = new IgnexWS(socket, {}, undefined);
    expect(ws.isSubscribed("t")).toBe(false);
    ws.subscribe("t");
    expect(ws.isSubscribed("t")).toBe(true);
    ws.unsubscribe("t");
    expect(ws.isSubscribed("t")).toBe(false);
  });

  it("cork passes the same wrapper to its callback", () => {
    const { socket } = fakeSocket();
    const ws = new IgnexWS(socket, {}, undefined);
    let inside: unknown;
    const result = ws.cork((inner) => {
      inside = inner;
      return 42;
    });
    expect(result).toBe(42);
    expect(inside).toBe(ws);
  });

  it("ping/pong/close/terminate and accessors behave", () => {
    const { socket, sent } = fakeSocket();
    const ws = new IgnexWS(socket, {}, undefined);
    ws.ping("p");
    ws.pong("o");
    ws.close(1000, "bye");
    ws.terminate();
    expect(sent[0]).toEqual(["ping", "p"]);
    expect(sent[1]).toEqual(["pong", "o"]);
    expect(sent[2]).toBe("__close__");
    expect(sent[3]).toBe("__terminate__");
    expect(ws.remoteAddress).toBe("198.51.100.9");
    expect(ws.readyState).toBe(1);
  });
});

describe("message dispatch", () => {
  it("passes binary messages through without JSON parsing", () => {
    const messages: unknown[] = [];
    const handler = createWSHandler({ message: (_ws, m) => messages.push(m) });
    const { socket } = fakeSocket();
    handler.message?.(socket, new Uint8Array([1, 2, 3]));
    expect(messages).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it("a throwing message hook never throws synchronously out of dispatch", () => {
    const handler = createWSHandler({
      message: () => {
        throw new Error("ws boom");
      },
    });
    const { socket } = fakeSocket();
    // Error containment: dispatch must not propagate the sync throw.
    expect(() => handler.message?.(socket, "x")).not.toThrow();
  });

  it("registry bookkeeping survives a throwing close hook", () => {
    const connections = createWSConnections<unknown, unknown, unknown>();
    const handler = createWSHandler(
      {
        close: () => {
          throw new Error("close boom");
        },
      },
      connections,
    );
    const { socket } = fakeSocket();
    handler.open?.(socket);
    expect(connections.size).toBe(1);

    expect(() => handler.close?.(socket, 1000, "bye")).not.toThrow();
    expect(connections.size).toBe(0); // socket still removed despite the throw
  });
});

describe("connection registry edge cases", () => {
  it("broadcast to an empty registry is a no-op", () => {
    const connections = createWSConnections<unknown, unknown, unknown>();
    expect(() => connections.broadcast("x")).not.toThrow();
    expect(() => connections.broadcastJson({ a: 1 })).not.toThrow();
  });

  it("drain and close still remove the socket from the registry", () => {
    const connections = createWSConnections<unknown, unknown, unknown>();
    const handler = createWSHandler({}, connections);
    const { socket } = fakeSocket();
    handler.open?.(socket);
    expect(connections.size).toBe(1);
    handler.drain?.(socket);
    expect(connections.size).toBe(1);
    handler.close?.(socket, 1000, "bye");
    expect(connections.size).toBe(0);
  });
});

// makeCtx is referenced by the upgrade port scenarios shared with ws.test.ts —
// kept here to mirror the original fake-server wiring.
void makeCtx;

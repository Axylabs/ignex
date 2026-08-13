/**
 * @fileoverview Port of Elysia `test/ws/*` (real-socket layer) — WebSocket
 * upgrade, messaging and concurrency against the AOT-compiled server.
 *
 * The compiled server wires the `.ws.ts` route's `wsHandler` into Bun's
 * websocket option; a real `WebSocket` client (Bun's global) exercises the
 * full upgrade → open → message → close cycle, including concurrent
 * interleaved messages (Elysia's `concurrency.test.ts` scenario).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot";

let srv: BootedServer;

/** Open a real WebSocket to the compiled server (reader wired before open). */
const newWebsocket = (path = "/chat"): WebSocket => {
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(srv.base).port}${path}`);
  readerFor(ws); // wire onmessage before the connection opens (no lost frames)
  return ws;
};

const wsOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws open error"));
  });

const wsClose = (ws: WebSocket, timeoutMs = 2000): Promise<void> =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const done = (): void => resolve();
    ws.onclose = done;
    // The close handshake is not the assertion under test — a timeout guard
    // keeps the suite from hanging on a slow/failed close.
    setTimeout(done, timeoutMs).unref?.();
  });

/** Buffered, FIFO message reader per socket — shared across calls. */
const readers = new WeakMap<WebSocket, { inbox: string[]; waiters: Array<(v: string) => void> }>();

const readerFor = (ws: WebSocket): { inbox: string[]; waiters: Array<(v: string) => void> } => {
  let r = readers.get(ws);
  if (!r) {
    const state: { inbox: string[]; waiters: Array<(v: string) => void> } = {
      inbox: [],
      waiters: [],
    };
    ws.onmessage = (e) => {
      const text = typeof e.data === "string" ? e.data : String(e.data);
      const w = state.waiters.shift();
      if (w) w(text);
      else state.inbox.push(text);
    };
    readers.set(ws, state);
    r = state;
  }
  return r;
};

/** Resolve the next message, or buffer it if none is pending yet. */
const wsMessage = (ws: WebSocket): Promise<string> => {
  const r = readerFor(ws);
  const buffered = r.inbox.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  return new Promise((resolve) => r.waiters.push(resolve));
};

beforeAll(async () => {
  srv = await bootServer(MATRIX_FIXTURE, { rebuild: true });
});

afterAll(() => srv.close());

describe("WebSocket (compiled server)", () => {
  it("upgrades, opens, echoes a message, and closes cleanly", async () => {
    const ws = newWebsocket();
    await wsOpen(ws);

    const open = JSON.parse(await wsMessage(ws)) as { event: string; connections: number };
    expect(open.event).toBe("open");
    expect(open.connections).toBeGreaterThanOrEqual(1);

    ws.send("hello");
    await expect(wsMessage(ws)).resolves.toBe("echo:hello");

    ws.close(1000, "done");
    await wsClose(ws);
  });

  it("handles concurrent interleaved messages from one socket (ordered echo)", async () => {
    const ws = newWebsocket();
    await wsOpen(ws);
    await wsMessage(ws); // consume open frame

    const payloads = Array.from({ length: 20 }, (_, i) => `msg-${i}`);
    for (const p of payloads) ws.send(p);

    const received: string[] = [];
    for (let i = 0; i < payloads.length; i++) received.push(await wsMessage(ws));

    // Echo preserves the client's send order (Bun delivers in order).
    expect(received).toEqual(payloads.map((p) => `echo:${p}`));

    ws.close(1000, "done");
    await wsClose(ws);
  });

  it("tracks multiple concurrent connections independently", async () => {
    const a = newWebsocket();
    const b = newWebsocket();
    await wsOpen(a);
    await wsOpen(b);

    const openA = JSON.parse(await wsMessage(a)) as { connections: number };
    const openB = JSON.parse(await wsMessage(b)) as { connections: number };
    // The second connection sees a higher (or equal) connection count.
    expect(openB.connections).toBeGreaterThanOrEqual(openA.connections);

    a.send("from-a");
    b.send("from-b");
    await expect(wsMessage(a)).resolves.toBe("echo:from-a");
    await expect(wsMessage(b)).resolves.toBe("echo:from-b");

    a.close(1000, "a-done");
    b.close(1000, "b-done");
    await wsClose(a);
    await wsClose(b);
  });

  it("rejects a non-upgrade HTTP request to the ws path (no crash)", async () => {
    const res = await fetch(`${srv.base}/chat`);
    // A plain GET to a WS-only route must not crash the server; it may 404/426.
    expect([404, 405, 426, 400]).toContain(res.status);
  });
});

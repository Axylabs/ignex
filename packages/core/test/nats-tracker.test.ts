/**
 * NatsEventTracker tests — the zero-dependency NATS client + event ring
 * buffer.
 *
 * Two layers of coverage:
 *  - Unit: ring-buffer semantics, stats, truncation, disabled state.
 *  - Wire: a minimal fake NATS server (node:net — vitest runs Node workers)
 *    exercises the real protocol (INFO/CONNECT/PING/PONG/SUB/PUB/MSG), and a
 *    real-NATS integration test runs when a server is reachable at
 *    `NATS_URL` (default `nats://127.0.0.1:4222`), skipping otherwise.
 */

import * as net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { NatsEventTracker } from "../src/debug/nats-tracker.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ── Bun shim (vitest runs Node workers: net-backed connect/listen) ── */

interface BunSocketLike {
  write(data: string): boolean;
  close(): void;
}
interface SocketHandlers {
  open?(s: BunSocketLike): void;
  data?(s: BunSocketLike, data: unknown): void;
  close?(s: BunSocketLike): void;
  error?(s: BunSocketLike, error: Error): void;
}

/** Wrap a CLIENT net.Socket (open fires on the 'connect' event). */
const shimClientSocket = (sock: net.Socket, handlers: SocketHandlers): BunSocketLike => {
  const shim: BunSocketLike = {
    write: (data: string) => sock.write(data),
    close: () => sock.destroy(),
  };
  sock.on("connect", () => handlers.open?.(shim));
  sock.on("data", (d) => handlers.data?.(shim, d));
  sock.on("close", () => handlers.close?.(shim));
  sock.on("error", (e) => handlers.error?.(shim, e));
  return shim;
};

/** Wrap a SERVER-side accepted socket: already connected, so open fires now. */
const shimServerSocket = (sock: net.Socket, handlers: SocketHandlers): BunSocketLike => {
  const shim: BunSocketLike = {
    write: (data: string) => sock.write(data),
    close: () => sock.destroy(),
  };
  handlers.open?.(shim);
  sock.on("data", (d) => handlers.data?.(shim, d));
  sock.on("close", () => handlers.close?.(shim));
  sock.on("error", (e) => handlers.error?.(shim, e));
  return shim;
};

/** Install the net-backed Bun shim (idempotent per test file run). */
const stubBun = (): void => {
  vi.stubGlobal("Bun", {
    connect(options: { hostname: string; port: number; socket: SocketHandlers }): BunSocketLike {
      const sock = net.createConnection({ host: options.hostname, port: options.port });
      return shimClientSocket(sock, options.socket);
    },
    listen(options: { hostname?: string; port: number; socket: SocketHandlers }) {
      const server = net.createServer((sock) => shimServerSocket(sock, options.socket));
      return new Promise<{ port: number; stop(): Promise<void> }>((resolve) => {
        server.listen(options.port, options.hostname ?? "127.0.0.1", () => {
          const address = server.address();
          resolve({
            port: typeof address === "object" && address !== null ? address.port : 0,
            stop: () => new Promise<void>((r) => server.close(() => r())),
          });
        });
      });
    },
  });
};

interface FakeNats {
  url: string;
  stop(): Promise<void>;
  published: Array<{ subject: string; payload: string }>;
  subscribed: string[];
  push(subject: string, payload: string): void;
}

/** Minimal NATS server over node:net (protocol subset used by the tracker). */
const startFakeNats = async (): Promise<FakeNats> => {
  stubBun();
  const published: Array<{ subject: string; payload: string }> = [];
  const subscribed: string[] = [];
  let client: BunSocketLike | null = null;
  let buffer = "";

  const server = await Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        client = sock;
        sock.write(
          'INFO {"server_id":"fake","version":"2.10.0","proto":1,"max_payload":1048576}\r\n',
        );
      },
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a test-only NATS server loop
      data(sock, data) {
        buffer +=
          typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8");
        for (;;) {
          const idx = buffer.indexOf("\r\n");
          if (idx === -1) return;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (line.startsWith("CONNECT ")) continue;
          if (line === "PING") {
            sock.write("PONG\r\n");
            continue;
          }
          if (line === "PONG") continue;
          if (line.startsWith("SUB ")) {
            const subject = line.split(" ")[1];
            if (subject) subscribed.push(subject);
            continue;
          }
          if (line.startsWith("PUB ")) {
            // PUB <subject> [reply] <size>
            const parts = line.split(" ");
            const size = Number(parts[parts.length - 1]);
            if (Number.isNaN(size) || buffer.length < size + 2) return;
            const payload = buffer.slice(0, size);
            buffer = buffer.slice(size + 2);
            published.push({ subject: parts[1] ?? "", payload });
          }
        }
      },
    },
  });

  return {
    url: `nats://127.0.0.1:${server.port}`,
    stop: server.stop,
    published,
    subscribed,
    push(subject, payload) {
      const bytes = Buffer.byteLength(payload, "utf8");
      client?.write(`MSG ${subject} 1 ${bytes}\r\n${payload}\r\n`);
    },
  };
};

describe("NatsEventTracker (unit)", () => {
  it("is disabled without a URL and never throws", () => {
    const tracker = new NatsEventTracker({});
    expect(tracker.enabled).toBe(false);
    expect(tracker.url).toBeNull();
    expect(tracker.stats().enabled).toBe(false);
    expect(tracker.stats().status).toBe("disabled");
    expect(tracker.list()).toEqual([]);
    const result = tracker.publish("a.b", { x: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not configured");
    tracker.stop(); // no-op
  });

  it("records outbound publishes even when the server is down", () => {
    const tracker = new NatsEventTracker({ url: "nats://127.0.0.1:1", connect: false });
    expect(tracker.enabled).toBe(true);
    const result = tracker.publish("orders.created", { id: "o-1" });
    expect(result.ok).toBe(false); // port 1: connection refused
    const stats = tracker.stats();
    expect(stats.total).toBe(1);
    expect(stats.out).toBe(1);
    expect(stats.bySubject["orders.created"]).toBe(1);
    const list = tracker.list();
    expect(list[0]?.subject).toBe("orders.created");
    expect(list[0]?.direction).toBe("out");
    expect(list[0]?.payload).toContain("o-1");
    tracker.stop();
  });

  it("caps the ring buffer at maxEvents", () => {
    const tracker = new NatsEventTracker({ url: "nats://x:1", maxEvents: 3, connect: false });
    for (let i = 0; i < 10; i++) tracker.publish(`s.${i}`, { i });
    expect(tracker.stats().total).toBe(3);
    const list = tracker.list();
    expect(list).toHaveLength(3);
    expect(list[0]?.subject).toBe("s.9");
    tracker.stop();
  });

  it("truncates payloads and aggregates stats", () => {
    const tracker = new NatsEventTracker({
      url: "nats://x:1",
      maxPayloadChars: 16,
      connect: false,
    });
    tracker.record("in", "ev.in", "x".repeat(100), null);
    tracker.record("out", "ev.out", "y", null);
    tracker.record("in", "ev.in", "z", "boom");
    const stats = tracker.stats();
    expect(stats.in).toBe(2);
    expect(stats.out).toBe(1);
    expect(stats.errors).toBe(1);
    expect(stats.bySubject["ev.in"]).toBe(2);
    const truncated = tracker.list().find((e) => e.size === 100);
    expect(truncated?.payload.length).toBe(16);
  });

  it("clear() drops the buffer but keeps the connection state", () => {
    const tracker = new NatsEventTracker({ url: "nats://x:1", connect: false });
    tracker.publish("a", {});
    expect(tracker.stats().total).toBe(1);
    tracker.clear();
    expect(tracker.stats().total).toBe(0);
    expect(tracker.get("nope")).toBeUndefined();
    tracker.stop();
  });
});

describe("NatsConnection + tracker (fake wire protocol)", () => {
  it("connects, subscribes, publishes and receives MSG frames", async () => {
    const fake = await startFakeNats();
    const tracker = new NatsEventTracker({
      url: fake.url,
      subjects: ["events.>"],
      maxEvents: 50,
    });
    try {
      tracker.start();
      await sleep(150);

      const stats = tracker.stats();
      expect(stats.connected).toBe(true);
      expect(fake.subscribed).toContain("events.>");

      // Outbound publish → the fake server sees it + the tracker records it.
      const result = tracker.publish("events.orders", { id: "o-9" });
      expect(result.ok).toBe(true);
      await sleep(50);
      expect(fake.published.length).toBe(1);
      expect(fake.published[0]?.subject).toBe("events.orders");
      expect(fake.published[0]?.payload).toContain("o-9");
      expect(tracker.stats().out).toBe(1);

      // Inbound MSG from the server → recorded as an inbound event.
      fake.push("events.pings", '{"ping":1}');
      await sleep(100);
      const list = tracker.list({ direction: "in" });
      expect(list.some((e) => e.subject === "events.pings")).toBe(true);
      expect(list.find((e) => e.subject === "events.pings")?.payload).toContain("ping");
    } finally {
      tracker.stop();
      await fake.stop();
    }
  });

  it("reports error status when the server is unreachable", async () => {
    stubBun();
    const tracker = new NatsEventTracker({ url: "nats://127.0.0.1:1", connect: true });
    tracker.start();
    await sleep(200);
    const stats = tracker.stats();
    expect(stats.connected).toBe(false);
    // Either still connecting or errored — but never "connected".
    expect(["error", "connecting", "reconnecting", "closed"]).toContain(stats.status);
    tracker.stop();
  });

  it("tracks inbound events recorded directly (app-driven)", () => {
    const tracker = new NatsEventTracker({ url: "nats://x:1", connect: false });
    tracker.record("in", "app.events", '{"a":1}', null);
    expect(tracker.stats().in).toBe(1);
    tracker.stop();
  });
});

describe("NatsEventTracker (real NATS)", () => {
  const natsUrl = process.env.NATS_URL ?? "nats://127.0.0.1:4222";

  /** Probe: is a NATS server reachable? */
  const natsReachable = async (): Promise<boolean> =>
    new Promise((resolve) => {
      const sock = net.createConnection({ host: "127.0.0.1", port: 4222 });
      const done = (ok: boolean): void => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(1500, () => done(false));
      sock.on("connect", () => done(true));
      sock.on("error", () => done(false));
    });

  it("connects to a live server, publishes + receives events", async (ctx) => {
    if (!(await natsReachable())) ctx.skip();
    const tracker = new NatsEventTracker({
      url: natsUrl,
      subjects: ["debugbar.test.>"],
      maxEvents: 50,
    });
    tracker.start();
    try {
      await sleep(300);
      expect(tracker.stats().connected).toBe(true);

      const result = tracker.publish("debugbar.test.orders", { id: "o-1", qty: 3 });
      expect(result.ok).toBe(true);
      await sleep(300);

      const stats = tracker.stats();
      // Outbound is recorded; the subscription also receives our own publish
      // (NATS delivers to every matching subscriber, including the publisher).
      expect(stats.out).toBeGreaterThanOrEqual(1);
      expect(stats.bySubject["debugbar.test.orders"]).toBeGreaterThanOrEqual(1);
      const out = tracker.list({ direction: "out" })[0];
      expect(out?.payload).toContain("o-1");
      const inbound = tracker
        .list({ direction: "in" })
        .find((e) => e.subject === "debugbar.test.orders");
      expect(inbound?.payload).toContain("o-1");
    } finally {
      tracker.stop();
    }
  });
});

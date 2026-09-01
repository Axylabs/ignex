/**
 * `novaPlugin` — the @ignex/nova realtime transport bridge.
 *
 * `@ignex/nova`'s published package imports `bun:ffi` at module top level, and
 * vitest workers do not expose `bun:ffi` (the same constraint `@ignex/native`
 * documents for its C-ABI transport). The real package is therefore exercised
 * under PLAIN BUN via `scripts/verify-nova-plugin.ts`; these unit tests inject
 * a fake loader so the plugin's own logic — lazy load, lifecycle, option
 * forwarding, auth bridge — is verified hermetically.
 */

import {
  createApp,
  type IgnexPlugin,
  novaAuthFromHook,
  novaMissingError,
  novaPlugin,
} from "@ignex/core";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fake nova `createServer` result the plugin drives. */
const fakeServer = () => ({
  port: 3001,
  publish: vi.fn(),
  publishTo: vi.fn(),
  publishToClient: vi.fn(),
  publishToTopic: vi.fn(),
  publishToGroup: vi.fn(),
  joinGroup: vi.fn(),
  getClients: vi.fn(() => []),
  getMetrics: vi.fn(() => ({})),
  drain: vi.fn(async () => {}),
  stop: vi.fn(),
});

/** Stub `Bun.serve` so a real port is never bound. */
const stubBun = (): { serve: ReturnType<typeof vi.fn> } => {
  const serve = vi.fn(() => ({ stop: vi.fn(), port: 3001 }));
  vi.stubGlobal("Bun", {
    serve,
    which: vi.fn(() => null),
    spawnSync: vi.fn(() => ({ exitCode: 0, stderr: "" })),
    file: vi.fn((p: string) => ({ path: p })),
  });
  return { serve };
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("novaPlugin lifecycle", () => {
  it("loads @ignex/nova lazily and creates the server at init()", async () => {
    stubBun();
    const handle = fakeServer();
    const createServer = vi.fn(() => handle);
    const plugin = novaPlugin({
      port: 3001,
      inbound: ["chat"],
      loader: async () => ({ createServer }),
    });

    // Before init: no server handle (the plugin is inert until the app
    // lifecycle starts it) — proving the package is loaded lazily.
    expect(plugin.server).toBeNull();

    const app = createApp({ plugins: [plugin], handler: () => new Response("ok") });
    await app.init();
    await flush();

    expect(createServer).toHaveBeenCalledTimes(1);
    expect(plugin.server).toBe(handle);
    const opts = createServer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.port).toBe(3001);
    expect(opts.inbound).toEqual(["chat"]);
    expect(opts.path).toBe("/ws");
  });

  it("close() drains and stops the server and clears the handle", async () => {
    stubBun();
    const handle = fakeServer();
    const plugin = novaPlugin({
      port: 3001,
      loader: async () => ({ createServer: () => handle }),
    });
    const app = createApp({ plugins: [plugin], handler: () => new Response("ok") });
    await app.init();
    await flush();
    await app.stop({ stopDeadlineMs: 100 });

    expect(handle.drain).toHaveBeenCalledWith(2000);
    expect(handle.stop).toHaveBeenCalledWith(true);
    expect(plugin.server).toBeNull();
  });

  it("enables the events layer by default (events: {} passed to createServer)", async () => {
    stubBun();
    const createServer = vi.fn(() => fakeServer());
    const plugin = novaPlugin({
      port: 3001,
      loader: async () => ({ createServer }),
    });
    const app = createApp({ plugins: [plugin], handler: () => new Response("ok") });
    await app.init();
    await flush();

    // The "no events hub bound" footgun: the plugin must enable the events
    // layer unless the caller explicitly overrides it.
    const opts = createServer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.events).toEqual({});
  });

  it("forwards an explicit events option", async () => {
    stubBun();
    const createServer = vi.fn(() => fakeServer());
    const plugin = novaPlugin({
      port: 3001,
      events: { cluster: { nats: true } },
      loader: async () => ({ createServer }),
    });
    const app = createApp({ plugins: [plugin], handler: () => new Response("ok") });
    await app.init();
    await flush();

    const opts = createServer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.events).toEqual({ cluster: { nats: true } });
  });

  it("forwards optional options (tls, nats, limits)", async () => {
    stubBun();
    const createServer = vi.fn(() => fakeServer());
    const plugin = novaPlugin({
      port: 3001,
      tls: { certFile: "c.pem", keyFile: "k.pem" },
      nats: { servers: ["nats://x"] },
      maxConnections: 100,
      maxMessageSize: 4096,
      idleTimeout: 0,
      loader: async () => ({ createServer }),
    });
    const app = createApp({ plugins: [plugin], handler: () => new Response("ok") });
    await app.init();
    await flush();

    const opts = createServer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.tls).toEqual({ certFile: "c.pem", keyFile: "k.pem" });
    expect(opts.nats).toEqual({ servers: ["nats://x"] });
    expect(opts.maxConnections).toBe(100);
    expect(opts.maxMessageSize).toBe(4096);
    expect(opts.idleTimeout).toBe(0);
  });

  it("forwards the trace option and exposes the event trace surface", async () => {
    stubBun();
    const handle = Object.assign(fakeServer(), {
      getEventTrace: vi.fn(() => ({
        enabled: true,
        capacity: 1024,
        stats: {
          size: 1,
          total: 1,
          inCount: 0,
          outCount: 1,
          bytes: 32,
          byName: { quote: 1 },
          last: null,
        },
        recent: [
          { seq: 1, ts: 1, direction: "out.emit", name: "quote", target: "broadcast", bytes: 32 },
        ],
      })),
      clearEventTrace: vi.fn(),
    });
    const createServer = vi.fn(() => handle);
    const plugin = novaPlugin({
      port: 3001,
      trace: { capturePayloadChars: 256 },
      loader: async () => ({ createServer }),
    });
    const app = createApp({ plugins: [plugin], handler: () => new Response("ok") });
    await app.init();
    await flush();

    // trace option reaches the nova server
    const opts = createServer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.trace).toEqual({ capturePayloadChars: 256 });

    // the running surface exposes the debugger-facing trace API
    expect(plugin.server?.getEventTrace?.()).toMatchObject({
      enabled: true,
      recent: [expect.objectContaining({ name: "quote", direction: "out.emit" })],
    });
    plugin.server?.clearEventTrace?.();
    expect(handle.clearEventTrace).toHaveBeenCalledTimes(1);
  });

  it("throws a descriptive error when @ignex/nova is missing", async () => {
    stubBun();
    const plugin = novaPlugin({
      port: 3001,
      loader: async () => {
        throw new Error("no module");
      },
    });
    const app = createApp({ plugins: [plugin], handler: () => new Response("ok") });
    await expect(app.init()).rejects.toThrow(/@ignex\/nova is not installed/);
  });
});

describe("novaAuthFromHook", () => {
  it("maps claims to a nova client record (sub → userId, groups, meta)", async () => {
    const hook = async (ctx: { state: Record<string, unknown> }) => {
      ctx.state.user = { sub: "u-42", id: "c-7", groups: ["premium"], tier: "gold" };
      return undefined;
    };
    const authenticate = novaAuthFromHook(hook as never);
    const result = (await authenticate(new Request("http://x/"))) as {
      userId?: string;
      id?: string;
      groups?: string[];
      meta?: Record<string, unknown>;
    };
    expect(result).toMatchObject({ userId: "u-42", id: "c-7", groups: ["premium"] });
    expect((result.meta as Record<string, unknown>).tier).toBe("gold");
  });

  it("rejects when the hook sets no user", async () => {
    const authenticate = novaAuthFromHook((async () => undefined) as never);
    expect(await authenticate(new Request("http://x/"))).toBe(false);
  });

  it("rejects when the hook returns a Response (auth challenge)", async () => {
    const authenticate = novaAuthFromHook(
      (async () => new Response("challenge", { status: 401 })) as never,
    );
    expect(await authenticate(new Request("http://x/"))).toBe(false);
  });
});

describe("novaMissingError", () => {
  it("mentions the install command", () => {
    expect(novaMissingError().message).toContain("bun add @ignex/nova");
  });
});

// Keep the unused import out of the unused-vars lint (documentation anchor).
void (0 as unknown as IgnexPlugin);

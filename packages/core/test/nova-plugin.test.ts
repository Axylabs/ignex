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

  it("forwards optional options (tls, events, nats, limits)", async () => {
    stubBun();
    const createServer = vi.fn(() => fakeServer());
    const plugin = novaPlugin({
      port: 3001,
      tls: { certFile: "c.pem", keyFile: "k.pem" },
      events: { cluster: { nats: true } },
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
    expect(opts.events).toEqual({ cluster: { nats: true } });
    expect(opts.nats).toEqual({ servers: ["nats://x"] });
    expect(opts.maxConnections).toBe(100);
    expect(opts.maxMessageSize).toBe(4096);
    expect(opts.idleTimeout).toBe(0);
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

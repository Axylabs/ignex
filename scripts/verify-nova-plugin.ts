/**
 * Verify the `novaPlugin` end-to-end against the REAL `@ignex/nova` package
 * under plain Bun — where `bun:ffi` and the nova addon are available
 * (vitest workers do not expose `bun:ffi`, so the unit tests in
 * `packages/core/test/nova-plugin.test.ts` inject a fake loader instead).
 * `@ignex/nova` resolves through the root `overrides` file: link to the
 * standalone ignex-nova repo (registry semver is the manifest default).
 *
 * Boots a `createApp` with `novaPlugin`, connects a real `@ignex/nova/client`
 * (binary FlatBuffer frames via the pure-JS encoder — no addon needed on the
 * client side), sends a typed `quote` event that the built-in registry allows
 * inbound, and asserts the server receives it and broadcasts a `trade` back.
 * Exits 0 on success, 1 on any failure.
 *
 * Usage:
 *   bun scripts/verify-nova-plugin.ts
 */

import { createApp, novaAuthFromHook, novaPlugin } from "@ignex/core";
import { createClient } from "@ignex/nova/client";

const PORT = 4012;

// Keep a direct handle on the plugin so the running server can be reached
// after init() (the app itself does not expose its plugin instances).
const nova = novaPlugin({
  port: PORT,
  path: "/ws",
  inbound: ["quote"],
  // Simple test identity: any request carrying ?token=t1 passes as u-1.
  authenticate: novaAuthFromHook((async (ctx: {
    req?: Request;
    state?: Record<string, unknown>;
  }) => {
    const url = ctx.req?.url ?? "";
    if (new URL(url).searchParams.get("token") === "t1") {
      ctx.state = {
        user: { sub: "u-1", groups: ["testers"] },
      };
    }
    return undefined;
  }) as never),
});

const app = createApp({
  plugins: [nova],
  handler: () => new Response("ok"),
});

const fail = (message: string): never => {
  console.error("FAIL:", message);
  process.exit(1);
};

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ]);

try {
  await app.init();
  const server = nova.server;
  if (!server) fail("novaPlugin did not expose a server after init");
  // The plugin's `server` is the real nova IgnServer; `on` registers an
  // inbound handler for the client's allowed event.
  const real = server as unknown as {
    on(name: string, handler: (payload: unknown) => void): void;
    publish(name: string, payload: unknown): void;
  };
  console.log(`[verify-nova] nova server up on ws://localhost:${PORT}/ws`);

  // Echo a broadcast `trade` back whenever a `quote` arrives — this proves the
  // server decoded the binary inbound frame and routed it to the handler.
  real.on("quote", () => {
    real.publish("trade", {
      symbol: "AAPL",
      price: 180.5,
      volume: 10,
      side: "buy",
      ts: Date.now(),
    });
  });

  const client = createClient(`ws://localhost:${PORT}/ws?token=t1`);
  const receivedTrade = new Promise<void>((resolve) => {
    client.on("trade", () => resolve());
  });
  const opened = new Promise<void>((resolve, reject) => {
    client.onStatus((status) => {
      if (status === "connected") resolve();
      if (status === "disconnected" || status === "closed") reject(new Error(`client ${status}`));
    });
  });
  client.connect();
  await withTimeout(opened, 5000, "client connect");

  client.send("quote", {
    symbol: "AAPL",
    bid: 180.1,
    ask: 180.2,
    bidSize: 100,
    askSize: 200,
    ts: Date.now(),
  });

  await withTimeout(receivedTrade, 5000, "server echo trade");
  console.log("[verify-nova] received the server's broadcast trade — OK");
  client.close();

  await app.stop({ stopDeadlineMs: 2000 });
  console.log("[verify-nova] OK — real @ignex/nova integration verified.");
  process.exit(0);
} catch (error) {
  console.error("[verify-nova] error:", error);
  try {
    await app.stop({ stopDeadlineMs: 1000 });
  } catch {
    // best-effort cleanup
  }
  process.exit(1);
}

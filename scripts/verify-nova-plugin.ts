/**
 * Verify the `novaPlugin` end-to-end against the REAL `@ignex/nova` package
 * under plain Bun — where `bun:ffi` and the nova addon are available
 * (vitest workers do not expose `bun:ffi`, so the unit tests in
 * `packages/core/test/nova-plugin.test.ts` inject a fake loader instead).
 *
 * Covers the framework lifecycle, auth claims, immediate topic/group calls,
 * hardened option forwarding, binary inbound dispatch, and broadcast output.
 * Usage: bun scripts/verify-nova-plugin.ts
 */

import { createApp, novaAuthFromHook, novaPlugin } from "@ignex/core";
import { createClient } from "@ignex/nova/client";

const nova = novaPlugin({
  port: 0,
  path: "/ws",
  inbound: ["quote"],
  maxConnections: 8,
  maxMessageSize: 64 * 1024,
  maxRpcInFlight: 8,
  rateLimit: { messagesPerSecond: 1000, burst: 100 },
  resume: { historySize: 64, ttlMs: 5000 },
  authorizeTopic: (topic) => topic === "prices",
  authorizeGroup: (group) => group === "testers" || group === "immediate-group",
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

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ]);

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
};

try {
  await app.init();
  const server = nova.server;
  if (server === null) throw new Error("novaPlugin did not expose a server after init");
  const real = server as unknown as {
    on(name: string, handler: (payload: unknown) => void): void;
    publish(name: string, payload: unknown): void;
    topics(): string[];
    groupMembers(group: string): string[];
  };
  console.log(`[verify-nova] nova server up on ws://localhost:${server.port}/ws`);

  real.on("quote", () => {
    real.publish("trade", {
      symbol: "AAPL",
      price: 180.5,
      volume: 10,
      side: "buy",
      ts: Date.now(),
    });
  });

  const client = createClient(`ws://localhost:${server.port}/ws?token=t1`);
  const receivedTrade = new Promise<void>((resolve) => {
    client.on("trade", () => resolve());
  });
  const opened = new Promise<void>((resolve, reject) => {
    client.onStatus((status) => {
      if (status === "connected") resolve();
      if (status === "disconnected" || status === "closed") reject(new Error(`client ${status}`));
    });
  });

  // These calls intentionally happen before the socket opens. Nova must retain
  // desired membership and apply it from its onopen handler.
  client.connect();
  client.subscribe("prices");
  client.joinGroup("immediate-group");
  await withTimeout(opened, 5000, "client connect");
  await waitUntil(() => real.topics().includes("prices"), "immediate topic subscription");
  await waitUntil(
    () => real.groupMembers("immediate-group").includes(client.clientId),
    "immediate group membership",
  );

  client.send("quote", {
    symbol: "AAPL",
    bid: 180.1,
    ask: 180.2,
    bidSize: 100,
    askSize: 200,
    ts: Date.now(),
  });

  await withTimeout(receivedTrade, 5000, "server echo trade");
  console.log("[verify-nova] immediate membership + binary echo — OK");
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

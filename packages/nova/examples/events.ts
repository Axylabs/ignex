/**
 * Events-layer smoke: the event-driven surface on top of the FlatBuffer core.
 * Type-checking this file (tsc / bun test) proves the events API surface
 * (hub + global emit + client records + groups + cluster options).
 *
 * The GLOBAL `emit`/`on` singleton is typed against the BUILT-IN registry
 * (quote/trade/…); custom-schema apps use `hub.on` / `hub.emit`
 * instead — fully typed against YOUR events.
 *
 *   - the events FILE: `hub.on(...)` receives client events with a
 *     context carrying the sender's client record;
 *   - the GLOBAL EMIT: `emit` / `emitToUser` / `emitToGroup` send events
 *     through websockets from anywhere;
 *   - client data ("on whose behalf" + per-connection state);
 *   - groups (client vs user) with explicit differentiation;
 *   - cluster sync options (NATS and/or Redis, offloaded from hot paths).
 */

import type { EmitTarget, EventsClusterOptions, EventsOptions } from "../public/events";
import {
  createMemoryStateStore,
  emit,
  emitToClient,
  emitToGroup,
  emitToUser,
  isEventsBound,
  on,
  onServerEvent,
} from "../public/events";
import { createServer } from "../public/server";

const cluster: EventsClusterOptions = {
  instanceId: "api-1",
  prefix: "myapp",
  nats: true, // reuse the server's NATS bridge (set options.nats too)
  // redis: { url: "redis://localhost:6379" },                          // Redis pub/sub (bun add ioredis)
  // state: createRedisStateStore({ url: "redis://localhost:6379" }),   // cluster-wide presence/indexes
  state: createMemoryStateStore(), // per-instance default
};

const events: EventsOptions = {
  cluster,
  onConnect(client) {
    client.data.set("since", client.connectedAt); // per-connection state
  },
  onDisconnect(client) {
    client.data.clear(); // (auto-cleared anyway)
  },
};

const server = createServer({
  port: 3000,
  events,
  nats: { servers: ["nats://localhost:4222"], inbound: true },
});

const hub = server.events!; // the events layer is enabled via `events`

if (isEventsBound()) {
  console.log("events: global emit bound");
}

// ── the events file: where events are received ─────────────────────────────
on("trade", (payload, ctx) => {
  const from = ctx.client; // the sender's connection record
  // react to a client-sent trade, then reply through websockets
  emitToClient(from?.id ?? "", "quote", {
    symbol: payload.symbol,
    bid: payload.price,
    ask: payload.price,
    bidSize: 1,
    askSize: 1,
    ts: Date.now(),
  });
  if (from) from.data.set("lastTradeTs", Date.now());
});

// server-side handling of events that arrive from OTHER instances / the bridge
onServerEvent("order", (payload, ctx) => {
  if (ctx.source === "remote") {
    // came from another instance — do NOT re-emit the same event (loop)
  }
  emitToGroup("backoffice", "portfolio", {
    accountId: payload.orderId,
    positions: [],
    totalValue: 0,
    cash: 0,
    ts: Date.now(),
  });
});

// ── the global emit: send events through websockets from anywhere ──────────
emit("quote", {
  symbol: "AAPL",
  bid: 180.1,
  ask: 180.2,
  bidSize: 100,
  askSize: 200,
  ts: Date.now(),
}); // broadcast
emitToUser("u-42", "quote", {
  symbol: "MSFT",
  bid: 420.1,
  ask: 420.2,
  bidSize: 1,
  askSize: 1,
  ts: Date.now(),
}); // every socket of u-42
emitToGroup("traders", "trade", {
  symbol: "AAPL",
  price: 180.5,
  volume: 10,
  side: "buy",
  ts: Date.now(),
}); // client group
const target: EmitTarget = { type: "user", userId: "u-7" };
emit(
  "quote",
  { symbol: "NVDA", bid: 950, ask: 951, bidSize: 1, askSize: 1, ts: Date.now() },
  target,
); // discriminated target

// client records — who is connected, on whose behalf, what to remember
hub.client("c-1")?.data.set("tier", "gold");
hub.setUserId("c-1", "u-42"); // bind a connection to an identity
const devices = hub.clientsByUser("u-42"); // multi-tab / multi-device

// groups — differentiated targeting
hub.group("premium").add("c-1"); // membership by connection id
hub.userGroup("ops").add("u-42"); // membership by user id
hub
  .userGroup("ops")
  .emit("trade", { symbol: "AAPL", price: 180.5, volume: 1, side: "sell", ts: Date.now() });

// horizontal scaling — presence + shared-state indexes
const remote = hub.clusterClients(); // connections on other instances
void (await hub.clusterUserClients("u-42"));
void (await hub.remoteClientData("c-1"));

// hygiene
export { devices, remote, server };

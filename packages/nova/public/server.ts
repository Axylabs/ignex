/**
 * Public server API — thin re-export shim (keeps the npm entrypoint + `dist`
 * build stable). The implementation lives in the functional modules under
 * `src/core/`; this file just exposes the public surface.
 *
 *   import { createServer } from "ignex-nova/server";
 *
 *   const server = createServer({ port: 3000 });
 *   server.publish("quote", { symbol: "AAPL", bid: 180.1, ask: 180.2, ... });
 *   server.publishTo(ws, "trade", { ... });
 *   server.join("equities", ws); server.publishToTopic("equities", "quote", {...});
 *
 *   // your own schema (see ignex-nova/generate):
 *   const server = createServer({ port: 3000, bindings });
 *   server.publish("yourEvent", {...}); // typed against YOUR Events
 *
 * Bun-only (bun:ffi + Bun.serve).
 */

export type {
  NatsBridge,
  NatsBridgeOptions,
  NatsBridgeStats,
  NatsBridgeStatus,
  NatsTransport,
} from "../src/bridge/nats";
// NATS bridge — re-exported so `nats` options on `createServer` are typed
// without a separate import (a standalone entrypoint is `ignex-nova/nats`).
export { createNatsBridge } from "../src/bridge/nats";
export type { Int64GuardMode } from "../src/core/int64-guard";
export type { MetricsSnapshot } from "../src/core/metrics";
export { type ClientInfo, createServer, type IgnServer } from "../src/core/server";
export type {
  AuthResult,
  BackpressurePolicy,
  ClientMeta,
  IgnBackpressureOptions,
  IgnServerOptions,
  WsData,
} from "../src/core/state";
// Events layer — re-exported so `createServer({ events })` is fully typed
// without a separate import (the runtime API is `ignex-nova/events`).
export type {
  ClientData,
  ClientGroup,
  ClusterStateStore,
  ClusterTransport,
  EmitTarget,
  EmitTargetKind,
  EventClient,
  EventContext,
  EventHandler,
  EventsClusterOptions,
  EventsHub,
  EventsMetricsSnapshot,
  EventsOptions,
  RedisConnectionOptions,
  RemoteClient,
  ServerEventHandler,
  UserGroup,
} from "../src/events/types";

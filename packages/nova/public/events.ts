/**
 * Public events API — the application-facing event-driven layer on top of the
 * FlatBuffer transport core.
 *
 *   import { createServer } from "ignex-nova/server";
 *   import { on, emit, emitToUser, emitToGroup } from "ignex-nova/events";
 *
 *   const server = createServer({ port: 3000, events: {} });
 *
 *   // the "events file": where events are received
 *   on("chat.message", (ctx) => {
 *     emitToUser(ctx.client.userId ?? "", "chat.ack", { ok: true });
 *   });
 *
 *   // the global emit: send events through websockets from anywhere
 *   emit("quote", { symbol: "AAPL", bid: 180.1, ask: 180.2, ... });   // broadcast
 *   emitToGroup("traders", "alert", { ... });                          // to a group
 *   emitToUser("u-42", "order.update", { ... });                       // to a user's sockets
 *
 * Typed against the BUILT-IN event registry; custom-schema apps use
 * `server.events` (fully typed against YOUR events) — or pass your bindings to
 * `createServer({ bindings, events })` and use `server.events`.
 *
 * The events layer is opt-in (`createServer({ events })`); without it there is
 * zero overhead and the singleton throws a descriptive error on use.
 */

export {
  createMemoryStateStore,
  createNatsClusterTransport,
  createRedisClusterTransport,
  createRedisStateStore,
} from "../src/events/cluster";
export {
  bindEvents,
  emit,
  emitToClient,
  emitToGroup,
  emitToTopic,
  emitToUser,
  getEventsHub,
  isEventsBound,
  off,
  offAny,
  offServerEvent,
  on,
  onAny,
  once,
  onServerEvent,
  unbindEvents,
} from "../src/events/global";
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
  EventSource,
  EventsClusterOptions,
  EventsHub,
  EventsMetricsSnapshot,
  EventsOptions,
  RedisConnectionOptions,
  RemoteClient,
  ServerEventHandler,
  UserGroup,
} from "../src/events/types";

/**
 * Events layer — internal barrel. Public entry: `public/events.ts`
 * (`ignex-nova/events`).
 */

export { createClientStore, createEventClient } from "./clients";
export {
  createClusterSubjects,
  createClusterSync,
  createMemoryStateStore,
  createNatsClusterTransport,
  createRedisClusterTransport,
  createRedisStateStore,
  decodeClusterMessage,
  encodeClusterMessage,
} from "./cluster";
export { createClientData } from "./data";
export { createEmitter, deliverLocal } from "./emit";
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
} from "./global";
export { createGroupManager } from "./groups";
export type { EventsHubInternal } from "./hub";
export { createEventsHub } from "./hub";
export { createTaskQueue } from "./queue";
export { createHandlerRegistry } from "./registry";
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
} from "./types";

/**
 * ignex-nova — public package root.
 *
 * Re-exports the full typed pub/sub API (server + client + NATS bridge +
 * schema types + generic bindings codegen) so a single `import ... from
 * "ignex-nova"` works in Bun projects.
 *
 * For leaner / target-specific imports use the subpath entrypoints — each
 * resolves to its own source file and tree-shakes independently:
 *
 *   import { createServer } from "ignex-nova/server";     // Bun-only (Rust FFI)
 *   import { createClient } from "ignex-nova/client";     // browser + Bun
 *   import { createNatsBridge } from "ignex-nova/nats";   // standalone bridge
 *   import { on, emit } from "ignex-nova/events";         // events layer + global emit
 *   import { generateBindings } from "ignex-nova/generate"; // ANY-schema codegen
 *   import { assembleBindings, defaultBindings } from "ignex-nova/bindings";
 *   import { encodeUtf8Into } from "ignex-nova/internal";   // codegen helpers
 *
 * Note: the root entry also pulls in the Bun-only server + FFI path, so
 * browser bundles should import "ignex-nova/client" instead.
 *
 * The README (and docs/publishing.md) covers consuming this from an npm
 * package: `bun add ignex-nova`, then use the subpaths above.
 */

export type {
  AssembleOptions,
  Bindings,
  BindingsParts,
  ControlEventNameOf,
  ControlEventsOf,
  DefaultBindings,
  DirectCall,
  DirectEncoder,
  DirectTables,
  EventNameOf,
  EventsOf,
} from "./public/bindings";
export { assembleBindings, defaultBindings } from "./public/bindings";
export type {
  ClientStatus,
  IgnClient,
  IgnClientOptions,
  IgnReconnectOptions,
} from "./public/client";

export { createClient } from "./public/client";
export type { GeneratedBindings, GenerateOptions, SchemaRegistry } from "./public/generate";
// ── generic bindings (ANY schema) ──────────────────────────────────────────
export { generateBindings } from "./public/generate";
// runtime helpers used by generated code (also exported via `ignex-nova/internal`)
export {
  checkInt64,
  encodeUtf8Into,
  ensureCapacity,
  pooledByteBuffer,
  setInt64GuardMode,
  utf8Len,
} from "./public/internal";
export type {
  NatsBridge,
  NatsBridgeOptions,
  NatsBridgeStats,
  NatsBridgeStatus,
  NatsTransport,
  SubjectBuilder,
} from "./public/nats";
export { createNatsBridge, createSubjectBuilder } from "./public/nats";
// events layer types (the runtime singleton API is `ignex-nova/events`)
export type {
  AuthResult,
  BackpressurePolicy,
  ClientData,
  ClientGroup,
  ClientInfo,
  ClientMeta,
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
  IgnBackpressureOptions,
  IgnServer,
  IgnServerOptions,
  Int64GuardMode,
  MetricsSnapshot,
  RedisConnectionOptions,
  RemoteClient,
  ServerEventHandler,
  UserGroup,
  WsData,
} from "./public/server";
export { createServer } from "./public/server";

// Plain-object payload types consumers type against (e.g. `Events["quote"]`).
// Import as types only — the runtime `events` registry is transport-internal.
export type {
  AnyEventName,
  ControlEventName,
  ControlEvents,
  EventName,
  Events,
} from "./src/schema";

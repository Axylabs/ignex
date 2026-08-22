/**
 * Shared types for the events layer — the typed, event-driven surface on top
 * of the FlatBuffer transport core.
 *
 * The events layer is the application-facing counterpart to `src/core/routing`:
 * the server transports frames; this layer receives them (via handlers, "like
 * routes are made") and emits them to websocket clients (the global `emit`),
 * with first-class client records ("who is connected, on whose behalf, and
 * what state does the app keep per connection"), named groups, and optional
 * cross-instance sync for horizontally scaled deployments.
 *
 * Everything here is type-only or interface-shaped; the runtime lives in the
 * sibling modules (`clients`, `registry`, `groups`, `cluster`, `emit`, `hub`).
 */
import type { ServerWebSocket } from "bun";
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../bindings/types";
import type { IgnServer } from "../core/server";
import type { WsData } from "../core/state";

// ── client records ──────────────────────────────────────────────────────────

/** Per-connection state store attached to an active client record. */
export interface ClientData {
  /** Read a value previously `set` on this connection. */
  get(key: string): unknown;
  /** Store a value on this connection (arbitrary app state, per socket). */
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  keys(): string[];
  entries(): Array<[string, unknown]>;
  toJSON(): Record<string, unknown>;
}

/**
 * An active user connection — the server-side representation of "who is
 * connected, on whose behalf, and what to remember about them".
 *
 * - `id` is the connection id (the socket identity, unique per connection).
 * - `userId` is the identity this connection acts ON BEHALF OF (set via the
 *   `authenticate` hook, `hub.setUserId`, or later); several connections may
 *   share a `userId` (multi-tab / multi-device), and `hub.clientsByUser`
 *   groups them.
 * - `data` is the per-connection app store, cleared automatically on close.
 * - `groups` / `topics` are shared with the transport (`ws.data`), so control
 *   frames (`joinGroup` / `subscribe`) stay consistent with the events layer.
 */
export interface EventClient {
  /** stable connection id (ws identity, unique per socket) */
  readonly id: string;
  /** identity this connection acts on behalf of (undefined = anonymous) */
  readonly userId: string | undefined;
  /** arbitrary app metadata from `authenticate` (undefined if none) */
  readonly meta: Record<string, unknown> | undefined;
  /** per-connection app state store (auto-cleared on disconnect) */
  readonly data: ClientData;
  /** server-side client groups this connection belongs to */
  readonly groups: ReadonlySet<string>;
  /** topics/rooms this connection has joined */
  readonly topics: ReadonlySet<string>;
  /** epoch ms the socket connected */
  readonly connectedAt: number;
  /** remote IP (from the socket) */
  readonly ip: string;
  /** true after the socket closed (record is then detached) */
  readonly closed: boolean;
  /** the underlying socket (advanced / low-level use) */
  readonly ws: ServerWebSocket<WsData>;
}

/** A connection known to exist on ANOTHER instance (via cluster presence). */
export interface RemoteClient {
  clientId: string;
  /** the instance that reported this connection */
  instanceId: string;
  userId?: string;
  /** epoch ms the connection was (re)confirmed by its instance */
  lastSeen: number;
}

// ── emit targets ────────────────────────────────────────────────────────────

/**
 * Where an emit goes. The discriminated union is how the API "easily
 * differentiates" between the addressing modes:
 *
 *   - `{ type: "broadcast" }` — every connected client, on every instance.
 *   - `{ type: "topic", topic }` — subscribers of a topic (rooms + replay).
 *   - `{ type: "group", group }` — members of a server-side group.
 *   - `{ type: "user", userId }` — every socket acting on behalf of `userId`.
 *   - `{ type: "client", clientId }` — one specific connection.
 *
 * Local delivery is synchronous and allocation-free (the transport scratch +
 * `ws.send` copy); the cross-instance fan-out (when a cluster is configured)
 * is deferred to the offload queue so the emit call never blocks.
 */
export type EmitTarget =
  | { type: "broadcast" }
  | { type: "topic"; topic: string }
  | { type: "group"; group: string }
  | { type: "user"; userId: string }
  | { type: "client"; clientId: string };

export type EmitTargetKind = EmitTarget["type"];

// ── event contexts ──────────────────────────────────────────────────────────

/** Where an event reached the hub from. */
export type EventSource = "client" | "remote" | "bridge";

/**
 * The context every handler receives — the "who / where / how do I reply"
 * bundle. For client-sent events `client` is the sender's record; for
 * server-side events (`onServerEvent`) there is no sender client.
 */
export interface EventContext<B extends Bindings = DefaultBindings> {
  /** where the event came from: a local client, another instance, or the bridge */
  readonly source: EventSource;
  /** the client that sent the event (undefined for remote/bridge events) */
  readonly client?: EventClient;
  /** the events hub (for `hub.emit`, groups, client data, …) */
  readonly hub: EventsHub<B>;
  /** the underlying server (raw `publish`/`publishToClient`/… escape hatch) */
  readonly server: IgnServer<B>;
  /** emit helpers bound to this hub (reply without importing the singleton) */
  emit<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K], target?: EmitTarget): void;
  emitToGroup<K extends EventNameOf<B>>(group: string, name: K, payload: EventsOf<B>[K]): void;
  emitToUser<K extends EventNameOf<B>>(userId: string, name: K, payload: EventsOf<B>[K]): void;
  emitToClient<K extends EventNameOf<B>>(clientId: string, name: K, payload: EventsOf<B>[K]): void;
  emitToTopic<K extends EventNameOf<B>>(topic: string, name: K, payload: EventsOf<B>[K]): void;
}

/** A handler registered on the hub (client-sent events). May be async. */
export type EventHandler<B extends Bindings, K extends EventNameOf<B>> = (
  payload: EventsOf<B>[K],
  ctx: EventContext<B>,
) => void | Promise<void>;

/** A handler for server-side events (remote instances / bridge inbound). */
export type ServerEventHandler<B extends Bindings, K extends EventNameOf<B>> = (
  payload: EventsOf<B>[K],
  ctx: EventContext<B>,
) => void | Promise<void>;

// ── groups ──────────────────────────────────────────────────────────────────

/** A named client group: membership by connection id, fan-out via the hub. */
export interface ClientGroup<B extends Bindings = DefaultBindings> {
  readonly name: string;
  /** add a connection (by id) to the group (idempotent) */
  add(clientId: string): void;
  remove(clientId: string): void;
  has(clientId: string): boolean;
  /** member connection ids */
  members(): string[];
  readonly size: number;
  /** emit an event to every member of this group (cluster-aware) */
  emit<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): void;
}

/** A named USER group: membership by `userId`, fan-out to every socket of each member user. */
export interface UserGroup<B extends Bindings = DefaultBindings> {
  readonly name: string;
  add(userId: string): void;
  remove(userId: string): void;
  has(userId: string): boolean;
  /** member user ids */
  members(): string[];
  readonly size: number;
  /** emit an event to every socket acting on behalf of each member user */
  emit<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): void;
}

// ── cluster sync ────────────────────────────────────────────────────────────

/**
 * Cross-instance messaging transport (server ⇄ server). NATS and Redis
 * adapters are provided; any broker that supports named channels + byte
 * payloads can be plugged in (tests use an in-memory bus). All calls are
 * fire-and-forget and are invoked from the offload queue, never from the WS
 * hot path.
 */
export interface ClusterTransport {
  readonly connected: boolean;
  /** synchronously hand bytes to the broker (throws → caller counts an error) */
  publish(subject: string, data: Uint8Array): void;
  /** subscribe; `cb` receives raw message bytes; returns an unsubscribe fn */
  subscribe(subject: string, cb: (data: Uint8Array) => void): () => void;
  close(): Promise<void>;
}

/**
 * Optional shared-state store (presence / cluster group membership / client
 * data). A memory implementation is used by default (per-instance); Redis is
 * the production choice for horizontally scaled deployments (`createRedisStateStore`).
 */
export interface ClusterStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, ttlMs: number): Promise<void>;
}

/** Redis connection options — a URL string or an ioredis options object. */
export type RedisConnectionOptions = string | Record<string, unknown>;

// ── metrics ─────────────────────────────────────────────────────────────────

/** Events-layer counters (folded into `server.getMetrics().events`). */
export interface EventsMetricsSnapshot {
  /** emit calls (all targets) */
  emitted: number;
  emittedByTarget: Record<EmitTargetKind, number>;
  /** frames written to local sockets by the events layer */
  deliveredLocal: number;
  /** frames handed to the cluster transport */
  clusterPublished: number;
  /** frames received from other instances */
  clusterReceived: number;
  /** frames dropped because they originated on this instance */
  clusterDroppedSelf: number;
  /** cluster transport / decode failures */
  clusterErrors: number;
  /** offload-queue: tasks accepted */
  queueQueued: number;
  /** offload-queue: tasks dropped (overflow) */
  queueDropped: number;
  /** offload-queue: task failures */
  queueErrors: number;
  /** handler exceptions (caught + isolated) */
  handlerErrors: number;
  /** local connected clients */
  connectedClients: number;
  /** remote clients known via cluster presence */
  remoteClients: number;
  /** active client groups / user groups */
  clientGroups: number;
  userGroups: number;
}

// ── hub ─────────────────────────────────────────────────────────────────────

/**
 * The events hub — the public API returned as `server.events` when
 * `createServer({ events: {...} })` is used, and the backing store for the
 * module-global `emit` / `on` singleton (`ignex-nova/events`).
 */
export interface EventsHub<B extends Bindings = DefaultBindings> {
  readonly server: IgnServer<B>;
  /** stable id of THIS instance (self-delivery dedupe in a cluster) */
  readonly instanceId: string;

  // ── receiving events (the "events file": where events come in) ────────
  on<K extends EventNameOf<B>>(name: K, handler: EventHandler<B, K>): EventsHub<B>;
  off<K extends EventNameOf<B>>(name: K, handler?: EventHandler<B, K>): EventsHub<B>;
  once<K extends EventNameOf<B>>(name: K, handler: EventHandler<B, K>): EventsHub<B>;
  /** every client-sent inbound event (name + payload + ctx) */
  onAny(cb: (name: EventNameOf<B>, payload: unknown, ctx: EventContext<B>) => void): EventsHub<B>;
  offAny(cb: (name: EventNameOf<B>, payload: unknown, ctx: EventContext<B>) => void): EventsHub<B>;
  /** server-side handlers for events from OTHER instances / the bridge */
  onServerEvent<K extends EventNameOf<B>>(name: K, handler: ServerEventHandler<B, K>): EventsHub<B>;
  offServerEvent<K extends EventNameOf<B>>(
    name: K,
    handler?: ServerEventHandler<B, K>,
  ): EventsHub<B>;
  /** event names with at least one handler */
  events(): EventNameOf<B>[];
  listenerCount(name: EventNameOf<B>): number;
  removeAllListeners(name?: EventNameOf<B>): EventsHub<B>;

  // ── emitting events (through websockets, cluster-aware) ───────────────
  emit<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K], target?: EmitTarget): void;
  emitToTopic<K extends EventNameOf<B>>(topic: string, name: K, payload: EventsOf<B>[K]): void;
  emitToGroup<K extends EventNameOf<B>>(group: string, name: K, payload: EventsOf<B>[K]): void;
  emitToUser<K extends EventNameOf<B>>(userId: string, name: K, payload: EventsOf<B>[K]): void;
  emitToClient<K extends EventNameOf<B>>(clientId: string, name: K, payload: EventsOf<B>[K]): void;

  // ── client records ("who is connected, on whose behalf") ──────────────
  client(id: string): EventClient | undefined;
  clients(): EventClient[];
  /** every connection acting on behalf of `userId` */
  clientsByUser(userId: string): EventClient[];
  readonly clientCount: number;
  /** bind a connection to an identity (on whose behalf it acts) */
  setUserId(clientId: string, userId: string): void;
  /** per-connection app state */
  setClientData(clientId: string, key: string, value: unknown): void;
  getClientData(clientId: string, key: string): unknown;
  clearClientData(clientId: string): void;

  // ── groups ────────────────────────────────────────────────────────────
  /** client group handle (membership by connection id) */
  group(name: string): ClientGroup<B>;
  /** live client-group names */
  groups(): string[];
  /** user group handle (membership by userId, fan-out to every socket) */
  userGroup(name: string): UserGroup<B>;
  /** live user-group names */
  userGroups(): string[];

  // ── horizontal scaling ────────────────────────────────────────────────
  /** connections known on other instances (presence; [] when unclustered) */
  clusterClients(): RemoteClient[];
  /** user→clients index from the shared state store, if configured */
  clusterUserClients(userId: string): Promise<Array<{ instanceId: string; clientId: string }>>;
  /** cluster-wide client-group members (shared state store), if configured */
  clusterGroupMembers(group: string): Promise<string[]>;
  /** cluster-wide user-group members (shared state store), if configured */
  clusterUserGroupMembers(group: string): Promise<string[]>;
  /** client data from the shared state store, if configured */
  remoteClientData(clientId: string): Promise<Record<string, unknown> | undefined>;

  // ── lifecycle / observability ─────────────────────────────────────────
  metrics(): EventsMetricsSnapshot;
  queueStats(): {
    pending: number;
    queued: number;
    processed: number;
    dropped: number;
    errors: number;
  };
  close(): Promise<void>;
}

// ── options ─────────────────────────────────────────────────────────────────

/**
 * `createServer({ events: EventsOptions })` — enables the events layer and
 * exposes it as `server.events`. The module-global `emit` / `on` singleton is
 * bound by default (`global: false` to opt out).
 */
export interface EventsOptions<B extends Bindings = DefaultBindings> {
  /**
   * App events clients are allowed to send to the hub. Default: every event
   * registered via `hub.on(...)` is auto-allowed on first use.
   */
  inbound?: EventNameOf<B>[];
  /** bind the module-global `emit`/`on` singleton (default true) */
  global?: boolean;
  /** called after a connection's client record is attached (seed `data`, …) */
  onConnect?: (client: EventClient) => void;
  /** called after a connection's client record is detached (cleanup) */
  onDisconnect?: (client: EventClient) => void;
  /** horizontal-scaling sync (server ⇄ server) */
  cluster?: EventsClusterOptions;
  /** offload-queue limits (the queue keeps cluster/state work off hot paths) */
  queue?: { workers?: number; maxPending?: number };
}

export interface EventsClusterOptions {
  /** stable id of this instance (default: random UUID) — self-dedupe */
  instanceId?: string;
  /** subject prefix (default: bindings subject prefix or "ignex") */
  prefix?: string;
  /**
   * NATS-based cluster messaging. `true` reuses the server's NATS bridge
   * connection (set `options.nats` too); pass `NatsBridgeOptions` to create a
   * dedicated bridge; pass a `NatsBridge` to reuse an existing one.
   */
  nats?: boolean | import("../bridge/nats").NatsBridgeOptions | import("../bridge/nats").NatsBridge;
  /** Redis pub/sub cluster messaging (lazy `ioredis`; subjects mirror NATS) */
  redis?: RedisConnectionOptions;
  /** pluggable messaging transport (tests / custom brokers) */
  transport?: ClusterTransport;
  /**
   * Shared-state store for presence / cluster group membership / client data.
   * Default: per-instance memory. Production: `createRedisStateStore(...)`.
   */
  state?: ClusterStateStore;
  /** presence re-announce + prune cadence (ms, default 15_000) */
  heartbeatMs?: number;
  /** remote presence TTL (ms, default 60_000) */
  presenceTtlMs?: number;
}

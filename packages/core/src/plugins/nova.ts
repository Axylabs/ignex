/**
 * @fileoverview `novaPlugin` — bridge the typed realtime transport
 * (`@ignex/nova`: TypeBox-driven FlatBuffer pub/sub over Bun WebSockets, Rust
 * FFI serializer) into an ignex app lifecycle.
 *
 * The plugin owns the nova server's lifetime (init → create, close → drain),
 * bridges nova's `authenticate` hook to ignex's auth hooks (`jwtAuth` /
 * `bearerAuth` / any `(req) => claims` verifier), and exposes the running
 * server on the plugin so the app can `publish`/`emit` typed events from
 * anywhere.
 *
 * `@ignex/nova` is an OPTIONAL peer dependency, loaded lazily in `init()`
 * (never at module import). When the package is not installed the plugin
 * throws a descriptive error at `init()` — the same optionality contract as
 * the `castrum` native addon — so an app that never registers the plugin pays
 * nothing, and an app that does gets a clear install hint.
 *
 * ```ts
 * import { jwtAuth, novaPlugin } from "@ignex/core";
 *
 * export const plugins: IgnexPlugin[] = [
 *   novaPlugin({
 *     port: 3001,
 *     // The events layer (typed on/emit/emitToUser) is enabled by default —
 *     // no `events` option needed. Pass `bindings` (from the generated
 *     // realtime SDK) to register your custom events.
 *     // Bridge nova's WS auth to the app's JWT hook: the returned claims
 *     // become the client record (id/userId/meta) the events layer uses.
 *     authenticate: jwtAuth({ secret }),
 *   }),
 * ];
 *
 * // anywhere in the app (after the hub binds at boot):
 * import { emitToUser } from "@ignex/nova/events";
 * emitToUser("u-42", "order.update", { id: "o-1" });
 * ```
 */
import type { IgnexContext } from "../http/context";
import type { HookFn } from "../lifecycle/hooks";
import type { IgnexPlugin } from "../lifecycle/plugin";

/** Identity metadata nova attaches to a connected client. */
export interface NovaClientMeta {
  /** Stable client id (e.g. from your session id or a UUID). */
  id?: string;
  /** The user this connection acts on behalf of (multi-device aware). */
  userId?: string;
  /** Seed client groups (e.g. `["premium"]` for tiered fan-out). */
  groups?: string[];
  /** Arbitrary app metadata attached to the client record. */
  meta?: Record<string, unknown>;
}

/** Result of the nova `authenticate` hook (boolean or identity metadata). */
export type NovaAuthResult = boolean | NovaClientMeta;

/** What `novaPlugin` forwards to `createServer` (subset of nova's options). */
export interface NovaPluginOptions {
  /** Port the WS server listens on. Required. */
  port: number;
  /** Bind hostname (default `0.0.0.0`). */
  hostname?: string;
  /** WebSocket path (default `/ws`). */
  path?: string;
  /**
   * App events clients are ALLOWED to send (control frames always allowed).
   * Default: every app event declared by `bindings` (`eventNameToId` keys) —
   * the allowlist is derived from the wire contract instead of being
   * hand-maintained (a stale hand-written list silently drops events before
   * their handlers run).
   */
  inbound?: readonly string[];
  /** How a WS connection authenticates. */
  authenticate?: (req: Request) => NovaAuthResult | Promise<NovaAuthResult>;
  /** TLS options (enables `wss://`). */
  tls?: Bun.ServeOptions<unknown>["tls"];
  /** Server-level idle timeout in seconds (0 disables). */
  idleTimeout?: number;
  /**
   * Enable the events layer (typed `on`/`emit`/`emitToUser` + presence).
   * Default: enabled (`{}`). Pass `false`-like/empty overrides only when you
   * need to tune hub options (e.g. `{ cluster: {...} }`).
   */
  events?: Record<string, unknown>;
  /**
   * Optional generated bindings (from `generateBindings`) — lets the server
   * carry app-defined schemas instead of the built-in registry.
   */
  bindings?: unknown;
  /** Optional NATS bridge options (horizontal scaling / cluster sync). */
  nats?: Record<string, unknown>;
  /** Maximum concurrent WS clients (reject 503 beyond). */
  maxConnections?: number;
  /** Maximum inbound frame size in bytes. */
  maxMessageSize?: number;
  /** Slow-consumer policy (default off). */
  backpressure?: Record<string, unknown>;
  /** Per-topic last-value replay on subscribe. */
  replay?: { historySize?: number };
  /**
   * Event trace ring options (what fired — the debugger's Nova panel).
   * Default: on with capacity 1024; `IGNEX_NOVA_TRACE=0` disables globally.
   * `capturePayloadChars` opt-in stores truncated JSON payload previews.
   */
  trace?: { capacity?: number; enabled?: boolean; capturePayloadChars?: number };
  /**
   * Injectable module loader (default: `import("@ignex/nova/server")`).
   * Exists for tests and exotic bundlers; the returned module must expose
   * `createServer`.
   */
  loader?: () => Promise<{ createServer(options: unknown): unknown }>;
}

/** One traced nova event row (what fired — see `NovaEventTrace`). */
export interface NovaEventTraceRow {
  seq: number;
  ts: number;
  /** out.publish | out.emit | in.client | in.remote | in.bridge */
  direction: string;
  name: string;
  target?: "broadcast" | "topic" | "group" | "user" | "client";
  key?: string;
  bytes: number;
  payload?: string;
}

/** The debugger-facing trace snapshot served by the debugbar's Nova panel. */
export interface NovaEventTrace {
  enabled: boolean;
  capacity: number;
  stats: {
    size: number;
    total: number;
    inCount: number;
    outCount: number;
    bytes: number;
    byName: Record<string, number>;
    last: { name: string; ts: number } | null;
  };
  recent: NovaEventTraceRow[];
}

/**
 * The running nova server surface the plugin exposes (lazy type).
 *
 * `events` is the typed events hub (present because the plugin enables the
 * events layer by default) — use it for typed emits when you need to avoid
 * the module-global facade, or reach it from routes/jobs via the exported
 * plugin instance (`plugin.server.events.emit("order.created", payload)`).
 */
export interface NovaServerHandle {
  readonly port: number;
  publish(name: string, payload: unknown): void;
  publishTo(ws: unknown, name: string, payload: unknown): void;
  publishToClient(id: string, name: string, payload: unknown): void;
  publishToTopic(topic: string, name: string, payload: unknown): void;
  publishToGroup(group: string, name: string, payload: unknown): void;
  joinGroup(clientId: string, group: string): void;
  getClients(): unknown[];
  getMetrics(): unknown;
  /** Typed events hub (on/emit/emitToUser + presence) — enabled by default. */
  readonly events?: NovaEventsHandle;
  /**
   * What fired recently in the FlatBuffer transport (emitted / published /
   * received), newest first — the debugbar Nova panel + MCP tool read this.
   * Present on @ignex/nova >= 0.1.x with the event-trace ring.
   */
  getEventTrace?(options?: { limit?: number; direction?: string; name?: string }): NovaEventTrace;
  /** Drop all retained trace rows (counters survive). */
  clearEventTrace?(): void;
  drain(timeoutMs?: number): Promise<void>;
  stop(force?: boolean): void;
}

/**
 * Minimal structural view of the events hub (avoids a hard type dependency
 * on the optional `@ignex/nova` peer — the generated SDK facade provides the
 * fully typed surface). Signatures mirror `@ignex/nova/events`.
 */
export interface NovaEventsHandle {
  on(name: string, handler: (payload: unknown, ctx: unknown) => void): void;
  once(name: string, handler: (payload: unknown, ctx: unknown) => void): void;
  off(name: string, handler?: (payload: unknown, ctx: unknown) => void): void;
  emit(name: string, payload: unknown, target?: { type: string; [k: string]: unknown }): void;
  emitToUser(userId: string, name: string, payload: unknown): void;
  /**
   * Deliver to the user on EVERY instance/service sharing the cluster mesh
   * (full mesh, no presence routing). Requires @ignex/nova >= 0.1.7.
   */
  emitToUserAnywhere(userId: string, name: string, payload: unknown): void;
  emitToClient(clientId: string, name: string, payload: unknown): void;
  emitToTopic(topic: string, name: string, payload: unknown): void;
  emitToGroup(group: string, name: string, payload: unknown): void;

  /** A connection known on ANOTHER instance/service (cluster presence). */
  remoteClients(): Array<{
    clientId: string;
    instanceId: string;
    userId?: string;
    lastSeen: number;
  }>;
  /**
   * Cluster-wide clients of a user from the shared-state registry (Redis) —
   * the "where is this user right now" answer across instances/services.
   * Resolves [] when no shared state store is configured.
   */
  clusterUserClients(userId: string): Promise<Array<{ instanceId: string; clientId: string }>>;
}

/** Error thrown when `@ignex/nova` is not installed but a plugin needs it. */
export const novaMissingError = (): Error =>
  new Error(
    "novaPlugin: @ignex/nova is not installed. Add it with `bun add @ignex/nova` " +
      "(the typed realtime transport with the Rust FFI serializer), or remove the " +
      "novaPlugin() entry from your app config.",
  );

/**
 * Bridge an ignex auth hook (e.g. `jwtAuth({ secret })`) to nova's
 * `authenticate`: the hook's resolved claims (or `null` → reject) become the
 * client identity nova records. The claims' `sub`/`userId`/`groups`/`id`
 * fields (when present) seed the client record the events layer uses.
 *
 * The hook receives an ignex context, so this adapter synthesizes the minimal
 * context nova's flow needs (the raw `Request` + a `state` bag for `setUser`).
 */
export const novaAuthFromHook =
  (hook: HookFn) =>
  async (req: Request): Promise<NovaAuthResult> => {
    const ctx = { req, state: {} } as unknown as IgnexContext;
    const result = await hook(ctx);
    if (result instanceof Response) return false;
    const user = (ctx as { state?: { user?: unknown } }).state?.user;
    if (user === undefined || user === null) return false;
    const record = user as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const userId =
      typeof record.sub === "string"
        ? record.sub
        : typeof record.userId === "string"
          ? record.userId
          : undefined;
    const groups = Array.isArray(record.groups)
      ? (record.groups as unknown[]).filter((g): g is string => typeof g === "string")
      : undefined;
    return {
      ...(id !== undefined ? { id } : {}),
      ...(userId !== undefined ? { userId } : {}),
      ...(groups !== undefined && groups.length > 0 ? { groups } : {}),
      meta: record,
    };
  };

/**
 * Derive the inbound allowlist from generated bindings: every app event in
 * `eventNameToId` (control events are excluded by the transport itself, which
 * short-circuits them before the allowlist check). Used when `inbound` is not
 * provided — the wire contract is the single source of truth.
 */
const deriveInboundFromBindings = (bindings: unknown): readonly string[] => {
  if (typeof bindings !== "object" || bindings === null) return [];
  const names = (bindings as { eventNameToId?: unknown }).eventNameToId;
  if (typeof names !== "object" || names === null) return [];
  return Object.keys(names as Record<string, number>);
};

/**
 * Create a plugin that runs a typed realtime server from `@ignex/nova`
 * inside the ignex lifecycle. The nova package is loaded lazily at `init()`.
 */
export const novaPlugin = (
  options: NovaPluginOptions,
): IgnexPlugin & {
  /** The running nova server, available after `init()`. */
  server: NovaServerHandle | null;
} => {
  let server: NovaServerHandle | null = null;

  return {
    name: "nova",
    version: "0.1.0",

    get server(): NovaServerHandle | null {
      return server;
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a mechanical options-forwarding block
    async init() {
      let nova: { createServer(options: unknown): unknown };
      try {
        nova = options.loader
          ? await options.loader()
          : ((await import("@ignex/nova/server")) as { createServer(options: unknown): unknown });
      } catch {
        throw novaMissingError();
      }

      const serverOptions: Record<string, unknown> = {
        port: options.port,
        hostname: options.hostname ?? "0.0.0.0",
        path: options.path ?? "/ws",
        inbound: [...(options.inbound ?? deriveInboundFromBindings(options.bindings))],
        ...(options.authenticate ? { authenticate: options.authenticate } : {}),
        ...(options.tls ? { tls: options.tls } : {}),
        ...(options.idleTimeout !== undefined ? { idleTimeout: options.idleTimeout } : {}),
        // The events layer (typed on/emit/emitToUser + the module-global
        // facade) is enabled BY DEFAULT — omitting `events` was the #1
        // "no events hub bound" footgun in scaffolded apps.
        events: options.events ?? {},
        ...(options.bindings ? { bindings: options.bindings } : {}),
        ...(options.nats ? { nats: options.nats } : {}),
        ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
        ...(options.maxMessageSize !== undefined ? { maxMessageSize: options.maxMessageSize } : {}),
        ...(options.backpressure ? { backpressure: options.backpressure } : {}),
        ...(options.replay ? { replay: options.replay } : {}),
        ...(options.trace ? { trace: options.trace } : {}),
      };

      server = nova.createServer(serverOptions) as NovaServerHandle;
    },

    async close() {
      const current = server;
      server = null;
      if (!current) return;
      try {
        await current.drain(2000);
      } catch {
        // Best-effort drain — a stuck socket must not block shutdown.
      }
      current.stop(true);
    },
  };
};

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
 *     inbound: ["chat"],
 *     // Bridge nova's WS auth to the app's JWT hook: the returned claims
 *     // become the client record (id/userId/meta) the events layer uses.
 *     authenticate: jwtAuth({ secret }),
 *   }),
 * ];
 *
 * // anywhere in the app:
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
  /** App events clients are ALLOWED to send (control frames always allowed). */
  inbound?: readonly string[];
  /** How a WS connection authenticates. */
  authenticate?: (req: Request) => NovaAuthResult | Promise<NovaAuthResult>;
  /** TLS options (enables `wss://`). */
  tls?: Bun.ServeOptions<unknown>["tls"];
  /** Server-level idle timeout in seconds (0 disables). */
  idleTimeout?: number;
  /** Enable the events layer (typed `on`/`emit`/`emitToUser` + presence). */
  events?: Record<string, unknown>;
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
   * Injectable module loader (default: `import("@ignex/nova/server")`).
   * Exists for tests and exotic bundlers; the returned module must expose
   * `createServer`.
   */
  loader?: () => Promise<{ createServer(options: unknown): unknown }>;
}

/** The running nova server surface the plugin exposes (lazy type). */
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
  drain(timeoutMs?: number): Promise<void>;
  stop(force?: boolean): void;
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
        inbound: [...(options.inbound ?? [])],
        ...(options.authenticate ? { authenticate: options.authenticate } : {}),
        ...(options.tls ? { tls: options.tls } : {}),
        ...(options.idleTimeout !== undefined ? { idleTimeout: options.idleTimeout } : {}),
        ...(options.events ? { events: options.events } : {}),
        ...(options.nats ? { nats: options.nats } : {}),
        ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
        ...(options.maxMessageSize !== undefined ? { maxMessageSize: options.maxMessageSize } : {}),
        ...(options.backpressure ? { backpressure: options.backpressure } : {}),
        ...(options.replay ? { replay: options.replay } : {}),
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

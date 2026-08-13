/**
 * @fileoverview WebSocket support: typed messages, topics, request upgrades,
 * and a live-connection registry.
 */

import type { ServerWebSocket, WebSocketHandler } from "../types";
import type { IgnexContext } from "./context";

/**
 * Typed websocket wrapper around a raw {@link ServerWebSocket}.
 *
 * `send`/`publish` pass strings and binary through verbatim and JSON-stringify
 * any other object, so handlers can send plain objects directly.
 */
export class IgnexWS<Context = unknown, Body = unknown, Response = unknown> {
  constructor(
    public raw: ServerWebSocket<Context>,
    public data: Context,
    public body: Body,
  ) {}

  send(data: Response | string | ArrayBuffer | Uint8Array, compress?: boolean): number {
    // Pass strings / binary through verbatim; JSON-stringify any other object.
    // `Response` is a generic type parameter, so `typeof`/`instanceof` cannot
    // narrow it away — the cast reflects that this branch is binary/string.
    if (typeof data !== "object" || data instanceof ArrayBuffer || data instanceof Uint8Array) {
      return this.raw.send(data as string | ArrayBuffer | Uint8Array, compress);
    }
    return this.raw.send(JSON.stringify(data), compress);
  }

  /** Explicitly serialize `data` as JSON (unambiguous, unlike `send`). */
  sendJson(data: unknown, compress?: boolean): number {
    return this.raw.send(JSON.stringify(data), compress);
  }

  sendText(data: string, compress?: boolean): number {
    return this.raw.sendText(data, compress);
  }
  sendBinary(data: ArrayBuffer | Uint8Array, compress?: boolean): number {
    return this.raw.sendBinary(data, compress);
  }
  close(code?: number, reason?: string): void {
    this.raw.close(code, reason);
  }
  terminate(): void {
    this.raw.terminate();
  }
  ping(data?: string | ArrayBuffer): number {
    return this.raw.ping(data);
  }
  pong(data?: string | ArrayBuffer): number {
    return this.raw.pong(data);
  }

  publish(topic: string, data: Response | string | ArrayBuffer, compress?: boolean): number {
    // Pass strings / binary through verbatim; JSON-stringify any other object.
    // `Response` is a generic type parameter — see `send`.
    if (typeof data !== "object" || data instanceof ArrayBuffer) {
      return this.raw.publish(topic, data as string | ArrayBuffer, compress);
    }
    return this.raw.publish(topic, JSON.stringify(data), compress);
  }

  subscribe(topic: string): void {
    this.raw.subscribe(topic);
  }
  unsubscribe(topic: string): void {
    this.raw.unsubscribe(topic);
  }
  isSubscribed(topic: string): boolean {
    return this.raw.isSubscribed(topic);
  }
  cork<T>(cb: (ws: IgnexWS<Context, Body, Response>) => T): T {
    return this.raw.cork(() => cb(this));
  }

  get remoteAddress(): string {
    return this.raw.remoteAddress;
  }
  get readyState(): number {
    return this.raw.readyState;
  }
  get subscriptions(): string[] {
    return this.raw.subscriptions;
  }
}

/**
 * User-facing websocket event hooks, dispatched by {@link createWSHandler}.
 *
 * `message` receives the parsed message (JSON-decoded when the frame was a
 * string and parsed successfully, otherwise the raw string/Buffer).
 */
export interface WSLocalHook<Context = unknown, Body = unknown, Response = unknown> {
  open?(ws: IgnexWS<Context, Body, Response>): void | Promise<void>;
  message?(ws: IgnexWS<Context, Body, Response>, message: Body): void | Promise<void>;
  drain?(ws: IgnexWS<Context, Body, Response>): void | Promise<void>;
  close?(ws: IgnexWS<Context, Body, Response>, code: number, reason: string): void | Promise<void>;
  /**
   * Upgrade customization. Either a static object merged into the socket's
   * `data` payload, or a function receiving the request context and returning
   * the socket's `data` (e.g. a loaded user). Consumed by {@link upgradeWS}.
   */
  upgrade?: Record<string, unknown> | ((ctx: IgnexContext) => unknown);
}

/** Options for {@link upgradeWS} / {@link createWSHandler}. */
export interface WSUpgradeOptions<Context> {
  /** Explicit socket data; merged with (or overridden by) `hook.upgrade`. */
  data?: Context;
  /** Extra response headers for the 101 Switching Protocols response. */
  headers?: Headers | Record<string, string>;
}

/**
 * Upgrade a request to a WebSocket, resolving the socket `data` from
 * `hook.upgrade` (a function result wins; a static object merges over
 * `options.data`). Returns `false` when the runtime has no upgrade path
 * (e.g. the interpreted path without a real `Bun.serve` handle).
 */
export const upgradeWS = <Context>(
  ctx: IgnexContext,
  hook: WSLocalHook<Context>,
  options: WSUpgradeOptions<Context> = {},
): boolean => {
  const server = ctx.server;
  if (!server?.upgrade) return false;

  const upgrade = hook.upgrade;
  let data: unknown = options.data;

  if (typeof upgrade === "function") {
    data = upgrade(ctx);
  } else if (upgrade && typeof upgrade === "object") {
    data = { ...(options.data as object), ...upgrade };
  }

  return server.upgrade(ctx.req, {
    ...(data !== undefined ? { data } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
};

/**
 * Live connection registry. Pass one to `createWSHandler` and every opened
 * socket is tracked (and removed on close), enabling broadcast-to-all without
 * manual socket bookkeeping.
 */
export interface WSConnections<Context = unknown, Body = unknown, Response = unknown> {
  readonly size: number;
  has(ws: IgnexWS<Context, Body, Response>): boolean;
  add(ws: IgnexWS<Context, Body, Response>): void;
  delete(ws: IgnexWS<Context, Body, Response>): void;
  clear(): void;
  /** Send a string/JSON-object message to every connected socket. */
  broadcast(data: Response | string | ArrayBuffer, compress?: boolean): void;
  /** Serialize + send an object to every connected socket. */
  broadcastJson(data: unknown, compress?: boolean): void;
}

/**
 * A live registry of connected {@link IgnexWS} sockets, with broadcast helpers.
 */
export const createWSConnections = <Context, Body, Response>(): WSConnections<
  Context,
  Body,
  Response
> => {
  const set = new Set<IgnexWS<Context, Body, Response>>();

  return {
    get size() {
      return set.size;
    },
    has: (ws) => set.has(ws),
    add: (ws) => {
      set.add(ws);
    },
    delete: (ws) => {
      set.delete(ws);
    },
    clear: () => {
      set.clear();
    },
    broadcast(data, compress) {
      for (const ws of set) ws.send(data, compress);
    },
    broadcastJson(data, compress) {
      for (const ws of set) ws.sendJson(data, compress);
    },
  };
};

/**
 * Build a raw {@link WebSocketHandler} from a {@link WSLocalHook}.
 *
 * Wraps each raw socket in a single persistent {@link IgnexWS} so hooks can
 * stash per-socket state on it. When `connections` is provided, sockets are
 * added on open and removed on close (so `broadcast` never hits dead sockets).
 *
 * @param hook - The user-facing event hooks.
 * @param connections - Optional live-socket registry to maintain.
 * @returns A handler ready for Bun's `upgrade`/websocket server config.
 */
export const createWSHandler = <Context, Body, Response>(
  hook: WSLocalHook<Context, Body, Response>,
  connections?: WSConnections<Context, Body, Response>,
): WebSocketHandler<Context> => {
  // One IgnexWS wrapper per raw socket so the SAME instance is delivered to
  // every event (open/message/close). That identity is required for the
  // connection registry and lets hooks stash per-socket state on `ws`.
  const bySocket = new WeakMap<ServerWebSocket<Context>, IgnexWS<Context, Body, Response>>();

  const wrap = (ws: ServerWebSocket<Context>): IgnexWS<Context, Body, Response> => {
    let wrapped = bySocket.get(ws);
    if (!wrapped) {
      wrapped = new IgnexWS(ws, ws.data, undefined as Body);
      bySocket.set(ws, wrapped);
    }
    return wrapped;
  };

  return {
    open(ws) {
      const wrapped = wrap(ws);
      connections?.add(wrapped);
      void hook.open?.(wrapped);
    },

    message(ws, message) {
      let parsed: unknown = message;

      if (typeof message === "string") {
        try {
          parsed = JSON.parse(message);
        } catch {
          // keep as string
        }
      }

      void hook.message?.(wrap(ws), parsed as Body);
    },

    drain(ws) {
      void hook.drain?.(wrap(ws));
    },

    close(ws, code, reason) {
      const wrapped = wrap(ws);
      void hook.close?.(wrapped, code, reason);
      connections?.delete(wrapped);
    },
  };
};

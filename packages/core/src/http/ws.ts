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
    //
    // A `Uint8Array` must NOT be JSON-stringified: that would corrupt binary
    // frames into `{"0":1}`-style text. Route it through `publishBinary` so
    // raw bytes reach the topic (matching `send`'s binary handling).
    if (typeof data !== "object" || data instanceof ArrayBuffer) {
      return this.raw.publish(topic, data as string | ArrayBuffer, compress);
    }
    if (data instanceof Uint8Array) {
      return this.raw.publishBinary(topic, data, compress);
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
 * WebSocket transport limits, mirroring Bun's `WebSocketHandler` tuning fields.
 *
 * Each field carries through to the returned handler object, so a single-route
 * server passes them to `Bun.serve` untouched; the compiled server merges them
 * strictest-wins across routes via {@link mergeWSLimits} when multiple WS
 * routes share Bun's single `websocket` handler.
 */
export interface WSLimits {
  /** Max message payload bytes per frame (Bun default far exceeds typical needs). */
  maxPayloadLength?: number;
  /** Backlog (bytes) at which Bun applies socket backpressure via `drain`. */
  backpressureLimit?: number;
  /** Close the connection instead of buffering when `backpressureLimit` hits. */
  closeOnBackpressureLimit?: boolean;
  /** Idle timeout (seconds) after which an idle socket is closed. */
  idleTimeout?: number;
}

/**
 * Dispatch-level options for {@link createWSHandler}.
 *
 * `maxInflightMessages` bounds concurrent unsettled message handlers per
 * handler: at the cap the socket is closed with 1013 ("Too many in-flight
 * messages") instead of queueing unbounded promise work — a slow or wedged
 * handler can no longer pin unbounded event-loop/memory per socket.
 */
export interface WSHandlerOptions extends WSLimits {
  /** Max concurrent in-flight message handlers (default {@link DEFAULT_MAX_INFLIGHT_MESSAGES}). */
  maxInflightMessages?: number;
}

/** Default in-flight message cap — matches Elysia's 256-message ceiling. */
export const DEFAULT_MAX_INFLIGHT_MESSAGES = 256;

/** Close code for exceeding the in-flight cap (RFC 6455 "too big data", reused). */
export const WS_INFLIGHT_LIMIT_CODE = 1013;

/** Reason attached to the 1013 close when the in-flight cap is exceeded. */
export const WS_INFLIGHT_LIMIT_REASON = "Too many in-flight messages";

/**
 * Merge per-route WS transport limits strictest-wins: the smallest
 * `maxPayloadLength`/`backpressureLimit`/`idleTimeout`, and
 * `closeOnBackpressureLimit: true` when ANY route opts in. Fields no handler
 * sets stay omitted so Bun's defaults are never clobbered by the spread.
 *
 * Used by the compiled server when multiple WS routes must share Bun's single
 * `websocket` handler (each route's own `wsHandler` can only reach the wire
 * through that one handler).
 *
 * @param handlers - Per-route limit objects (typically each route's `wsHandler`).
 * @returns The strictest merged limits, omitting unset fields.
 */
export const mergeWSLimits = (handlers: readonly WSLimits[]): WSLimits => {
  const out: WSLimits = {};
  for (const h of handlers) {
    if (h.maxPayloadLength !== undefined) {
      out.maxPayloadLength =
        out.maxPayloadLength === undefined
          ? h.maxPayloadLength
          : Math.min(out.maxPayloadLength, h.maxPayloadLength);
    }
    if (h.backpressureLimit !== undefined) {
      out.backpressureLimit =
        out.backpressureLimit === undefined
          ? h.backpressureLimit
          : Math.min(out.backpressureLimit, h.backpressureLimit);
    }
    if (h.closeOnBackpressureLimit === true) out.closeOnBackpressureLimit = true;
    if (h.idleTimeout !== undefined) {
      out.idleTimeout =
        out.idleTimeout === undefined ? h.idleTimeout : Math.min(out.idleTimeout, h.idleTimeout);
    }
  }
  return out;
};

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
 * When `options` are provided, transport limits are spread onto the returned
 * handler (reaching `Bun.serve` for a single-route server) and the in-flight
 * message cap applies (default 256 — see {@link WSHandlerOptions}).
 *
 * @param hook - The user-facing event hooks.
 * @param connections - Optional live-socket registry to maintain.
 * @param options - Optional dispatch/transport limits (see {@link WSHandlerOptions}).
 * @returns A handler ready for Bun's `upgrade`/websocket server config.
 */
export const createWSHandler = <Context, Body, Response>(
  hook: WSLocalHook<Context, Body, Response>,
  connections?: WSConnections<Context, Body, Response>,
  options?: WSHandlerOptions,
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

  /**
   * Invoke a user hook with error containment: a synchronously-throwing (or
   * rejecting) message/open/close/drain hook must never crash socket dispatch
   * or take down the connection registry bookkeeping. Async rejections are
   * surfaced (unhandled) rather than silently swallowed; sync throws are
   * caught and reported so the event loop stays healthy.
   *
   * Returns the (settled) promise for async hooks so callers can observe
   * completion (the in-flight cap decrements once a handler settles); sync
   * hooks return `undefined`.
   */
  const invoke = (fn: () => unknown): Promise<void> | undefined => {
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result
          .catch((err) => console.error("[ignex] websocket hook error:", err))
          .then(() => undefined);
      }
    } catch (err) {
      console.error("[ignex] websocket hook error:", err);
    }
    return undefined;
  };

  const cap = options?.maxInflightMessages ?? DEFAULT_MAX_INFLIGHT_MESSAGES;
  let inFlight = 0;

  // Transport limits reach Bun's single websocket handler only when spread
  // here (a plain handler object has no other path to `Bun.serve`).
  const transport: WSLimits = {};
  if (options?.maxPayloadLength !== undefined)
    transport.maxPayloadLength = options.maxPayloadLength;
  if (options?.backpressureLimit !== undefined)
    transport.backpressureLimit = options.backpressureLimit;
  if (options?.closeOnBackpressureLimit === true) transport.closeOnBackpressureLimit = true;
  if (options?.idleTimeout !== undefined) transport.idleTimeout = options.idleTimeout;

  return {
    ...transport,

    open(ws) {
      const wrapped = wrap(ws);
      connections?.add(wrapped);
      invoke(() => hook.open?.(wrapped));
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

      // In-flight cap: a handler that never settles must not let the socket
      // (and the event loop) accumulate unbounded pending work. At the cap the
      // connection is closed with 1013 instead of queuing another dispatch.
      if (inFlight >= cap) {
        ws.close(WS_INFLIGHT_LIMIT_CODE, WS_INFLIGHT_LIMIT_REASON);
        return;
      }
      inFlight++;
      const pending = invoke(() => hook.message?.(wrap(ws), parsed as Body));
      if (pending) {
        void pending.finally(() => {
          inFlight--;
        });
      } else {
        inFlight--;
      }
    },

    drain(ws) {
      invoke(() => hook.drain?.(wrap(ws)));
    },

    close(ws, code, reason) {
      const wrapped = wrap(ws);
      invoke(() => hook.close?.(wrapped, code, reason));
      connections?.delete(wrapped);
    },
  };
};

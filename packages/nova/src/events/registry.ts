/**
 * Handler registry — the "events file receives events" core. An ordered,
 * multi-handler-per-event registry with per-handler error isolation:
 * one throwing handler never prevents the others, and every failure is
 * counted (surfaced via `hub.metrics().handlerErrors`).
 *
 * Supports `on` / `off` / `once` / `onAny` / `removeAllListeners` and a
 * separate server-event registry (`onServerEvent`) for events that arrive
 * from other instances or the NATS bridge.
 *
 * The registry is BINDINGS-AGNOSTIC: names and payloads are `unknown` here,
 * and the `ctx` is passed through opaquely (the hub types it as
 * `EventContext<B>` at the boundary).
 */

/** Opaque context — the hub hands a typed `EventContext<B>` through. */
export type DispatchContext = unknown;

type AnyHandler = (payload: unknown, ctx: DispatchContext) => void | Promise<void>;

export interface HandlerRegistry {
  on(name: string, handler: AnyHandler): void;
  off(name: string, handler?: AnyHandler): void;
  once(name: string, handler: AnyHandler): void;
  onAny(cb: AnyHandler): void;
  offAny(cb: AnyHandler): void;
  has(name: string): boolean;
  names(): string[];
  count(name: string): number;
  removeAll(name?: string): void;
  /** dispatch to every handler for `name` + every onAny handler. Isolated. */
  dispatch(name: string, payload: unknown, ctx: DispatchContext): void;
  /** register a server-side handler (remote / bridge events only) */
  onServerEvent(name: string, handler: AnyHandler): void;
  offServerEvent(name: string, handler?: AnyHandler): void;
  /** true when a server-event handler exists for `name` (avoids payload decode). */
  wantsServerEvent(name: string): boolean;
  dispatchServerEvent(name: string, payload: unknown, ctx: DispatchContext): void;
  onError(cb: (err: Error, name: string) => void): void;
  /** total handler exceptions since creation */
  readonly errorCount: number;
}

function invoke(
  handler: AnyHandler,
  payload: unknown,
  ctx: DispatchContext,
  onError: (err: Error) => void,
): void {
  try {
    const r = handler(payload, ctx);
    if (r && typeof (r as Promise<void>).then === "function") {
      void (r as Promise<void>).catch((err: unknown) =>
        onError(err instanceof Error ? err : new Error(String(err))),
      );
    }
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export function createHandlerRegistry(): HandlerRegistry {
  const handlers = new Map<string, Set<AnyHandler>>();
  const anyHandlers = new Set<AnyHandler>();
  const serverHandlers = new Map<string, Set<AnyHandler>>();
  const errorCbs: Array<(err: Error, name: string) => void> = [];
  let errorCount = 0;

  const report = (err: Error, name: string): void => {
    errorCount++;
    for (const cb of errorCbs) {
      try {
        cb(err, name);
      } catch {
        // error reporters must never break dispatch
      }
    }
  };

  const add = (name: string, handler: AnyHandler): void => {
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(handler);
  };

  const addServer = (name: string, handler: AnyHandler): void => {
    let set = serverHandlers.get(name);
    if (!set) {
      set = new Set();
      serverHandlers.set(name, set);
    }
    set.add(handler);
  };

  return {
    on(name, handler) {
      add(name, handler);
    },
    off(name, handler) {
      if (!handler) {
        handlers.delete(name);
        return;
      }
      handlers.get(name)?.delete(handler);
    },
    once(name, handler) {
      const wrap: AnyHandler = (payload, ctx) => {
        handlers.get(name)?.delete(wrap);
        return handler(payload, ctx);
      };
      add(name, wrap);
    },
    onAny(cb) {
      anyHandlers.add(cb);
    },
    offAny(cb) {
      anyHandlers.delete(cb);
    },
    has(name) {
      return handlers.has(name) || anyHandlers.size > 0;
    },
    names() {
      return [...handlers.keys()];
    },
    count(name) {
      return handlers.get(name)?.size ?? 0;
    },
    removeAll(name) {
      if (name) handlers.delete(name);
      else handlers.clear();
    },
    dispatch(name, payload, ctx) {
      const set = handlers.get(name);
      if (set) {
        const snapshot = [...set];
        for (const h of snapshot) {
          invoke(h, payload, ctx, (err) => report(err, name));
        }
      }
      if (anyHandlers.size > 0) {
        const snapshot = [...anyHandlers];
        for (const h of snapshot) {
          invoke(
            (p) => {
              (h as (n: string, p: unknown, c: DispatchContext) => unknown)(name, p, ctx);
            },
            payload,
            ctx,
            (err) => report(err, name),
          );
        }
      }
    },
    wantsServerEvent(name) {
      return (serverHandlers.get(name)?.size ?? 0) > 0;
    },
    onServerEvent(name, handler) {
      addServer(name, handler);
    },
    offServerEvent(name, handler) {
      if (!handler) {
        serverHandlers.delete(name);
        return;
      }
      serverHandlers.get(name)?.delete(handler);
    },
    dispatchServerEvent(name, payload, ctx) {
      const set = serverHandlers.get(name);
      if (!set) return;
      const snapshot = [...set];
      for (const h of snapshot) {
        invoke(h, payload, ctx, (err) => report(err, name));
      }
    },
    onError(cb) {
      errorCbs.push(cb);
    },
    get errorCount(): number {
      return errorCount;
    },
  };
}

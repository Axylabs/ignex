/**
 * @fileoverview Plugin Architecture v3.1
 * Lifecycle hooks, extensibility, composable plugins.
 */

import type { FluxContext } from "../http/context";
import type { HookContainer, LifeCycleStore } from "../types";
import type { HookFn } from "./hooks";

// ============================================================================
// Plugin Interface
// ============================================================================

export interface FluxPlugin {
  readonly name: string;
  readonly version?: string;

  // Lifecycle
  init?(): MaybePromise<void>;
  close?(): MaybePromise<void>;

  // Request lifecycle
  onRequest?(ctx: FluxContext): MaybePromise<FluxContext | Response>;
  onResponse?(ctx: FluxContext, response: Response): MaybePromise<Response>;
  onError?(error: Error, ctx: FluxContext): MaybePromise<Response | void>;
}

type MaybePromise<T> = T | Promise<T>;

// ============================================================================
// Plugin Registry
// ============================================================================

export interface PluginContext {
  plugins: FluxPlugin[];
  hooks: Map<string, HookFn[]>;
  addHook(name: string, hook: HookFn): void;
  getHooks(name: string): readonly HookFn[];
  register(plugin: FluxPlugin): void;
  initAll(): Promise<void>;
  closeAll(): Promise<void>;
}

export const createPluginContext = (): PluginContext => {
  const hooks = new Map<string, HookFn[]>();
  const plugins: FluxPlugin[] = [];

  return {
    plugins,
    hooks,
    addHook(name, hook) {
      const existing = hooks.get(name) ?? [];
      existing.push(hook);
      hooks.set(name, existing);
    },
    getHooks(name) {
      return hooks.get(name) ?? [];
    },
    register(plugin) {
      plugins.push(plugin);
    },
    async initAll() {
      // Run every plugin's init even if one fails; report failures but don't
      // leave later plugins un-initialized.
      const results = await Promise.allSettled(plugins.map((p) => p.init?.()));
      for (const r of results) {
        if (r.status === "rejected") console.error("[flux] plugin init failed:", r.reason);
      }
    },
    async closeAll() {
      // Reverse (onion) order: last registered closes first. allSettled ensures
      // one plugin's close failure never skips the remaining plugins' cleanup.
      const results = await Promise.allSettled([...plugins].reverse().map((p) => p.close?.()));
      for (const r of results) {
        if (r.status === "rejected") console.error("[flux] plugin close failed:", r.reason);
      }
    },
  };
};

// ============================================================================
// Plugin Composition
// ============================================================================

export const composePlugins = (...plugins: FluxPlugin[]): FluxPlugin => ({
  name: plugins.map((p) => p.name).join("+"),
  async init() {
    for (const p of plugins) await p.init?.();
  },
  async close() {
    for (const p of [...plugins].reverse()) await p.close?.();
  },
  async onRequest(ctx) {
    let current = ctx;
    for (const p of plugins) {
      const result = await p.onRequest?.(current);
      if (result instanceof Response) return result;
      if (result) current = result;
    }
    return current;
  },
  async onResponse(ctx, response) {
    let current = response;
    for (const p of [...plugins].reverse()) {
      current = (await p.onResponse?.(ctx, current)) ?? current;
    }
    return current;
  },
  async onError(error, ctx) {
    for (const p of plugins) {
      const result = await p.onError?.(error, ctx);
      if (result instanceof Response) return result;
    }
  },
});

// ============================================================================
// Plugin -> Lifecycle Bridge
// ============================================================================

function isFluxPlugin(value: unknown): value is FluxPlugin {
  return typeof value === "object" && value !== null && "name" in value;
}

const LIFECYCLE_STAGES = [
  "start",
  "request",
  "parse",
  "transform",
  "beforeHandle",
  "afterHandle",
  "mapResponse",
  "afterResponse",
  "error",
  "stop",
] as const;

/**
 * Convert hooks registered on a {@link PluginContext} (via `addHook`) into
 * lifecycle stage containers. This is what makes legacy callable/`setup`
 * plugins — which register hooks on the context — actually run, instead of
 * being invoked for side effects and then silently dropped.
 */
export const pluginContextToLifecycle = (ctx: PluginContext): Partial<LifeCycleStore> => {
  const out: Partial<LifeCycleStore> = {};

  for (const stage of LIFECYCLE_STAGES) {
    const hooks = ctx.getHooks(stage);
    if (hooks.length === 0) continue;
    out[stage] = hooks.map((hook) => ({ scope: "global" as const, fn: hook }));
  }

  return out;
};

export const pluginsToLifeCycle = (plugins: unknown[]): Partial<LifeCycleStore> => {
  const list = (plugins ?? []).flat().filter(isFluxPlugin);

  const request: HookContainer[] = list
    .filter((p) => typeof p.onRequest === "function")
    .map((p) => ({
      scope: "global" as const,
      fn: async (ctx: FluxContext) => {
        const result = await p.onRequest!(ctx);
        if (result instanceof Response) {
          return { response: result };
        }
        if (result) {
          return { ctx: result };
        }
        return { ctx };
      },
    }));

  const onResponsePlugins = [...list].reverse().filter((p) => typeof p.onResponse === "function");

  // `onResponse` is the onion "way out" phase: the LAST-registered plugin wraps
  // the previous ones' response — identical to `composePlugins`.
  //
  // IMPORTANT: all onResponse plugins are composed into ONE afterHandle hook.
  // `runHooks` halts the chain when a hook returns `{ response }`, so if each
  // plugin were its own hook only the first would ever run (security would
  // silently swallow compression + cors). Composing them threads the response
  // through every plugin regardless of whether they return a new Response or
  // `undefined` (pass-through).
  const afterHandle: HookContainer[] =
    onResponsePlugins.length === 0
      ? []
      : [
          {
            scope: "global" as const,
            fn: async (ctx: FluxContext, response: Response) => {
              let current = response;
              for (const p of onResponsePlugins) {
                const result = await p.onResponse!(ctx, current);
                if (result instanceof Response) current = result;
              }
              return { response: current };
            },
          },
        ];

  const error: HookContainer[] = list
    .filter((p) => typeof p.onError === "function")
    .map((p) => ({
      scope: "global" as const,
      fn: async (ctx: FluxContext, error: unknown) => {
        const result = await p.onError!(
          error instanceof Error ? error : new Error(String(error)),
          ctx,
        );
        if (result instanceof Response) {
          return { response: result };
        }
        return {};
      },
    }));

  return {
    request,
    afterHandle,
    error,
  };
};

/**
 * Wrap a single `HookFn` as a `FluxPlugin` — the shared adapter behind the
 * auth / csrf / session plugin factories. An optional `close` callback is wired
 * to the plugin's `close()` so resources (stores, timers) are released on app
 * shutdown.
 */
export const hookToPlugin = (name: string, hook: HookFn, close?: () => void): FluxPlugin => ({
  name,
  async onRequest(ctx) {
    const result = await hook(ctx);
    return result.ok ? result.ctx : result.response;
  },
  ...(close ? { close } : {}),
});

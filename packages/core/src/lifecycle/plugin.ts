/**
 * @fileoverview Plugin Architecture v3.1
 * Lifecycle hooks, extensibility, composable plugins.
 */

import type { IgnexContext } from "../http/context";
import type { HookContainer, LifeCycleStore } from "../types";
import type { HookFn } from "./hooks";

// ============================================================================
// Plugin Interface
// ============================================================================

/**
 * A composable plugin: lifecycle hooks plus optional init/close lifecycle.
 *
 * `onRequest`/`onResponse`/`onError` run in onion order around the handler.
 * `init`/`close` manage resources (stores, timers) at app boot/shutdown.
 */
export interface IgnexPlugin {
  readonly name: string;
  readonly version?: string;

  // Lifecycle
  init?(): MaybePromise<void>;
  close?(): MaybePromise<void>;

  // Request lifecycle
  onRequest?(ctx: IgnexContext): MaybePromise<IgnexContext | Response>;
  onResponse?(ctx: IgnexContext, response: Response): MaybePromise<Response>;
  onError?(error: Error, ctx: IgnexContext): MaybePromise<Response | undefined>;
}

type MaybePromise<T> = T | Promise<T>;

// ============================================================================
// Plugin Registry
// ============================================================================

/**
 * The plugin registry: tracks registered plugins and named hooks, and drives
 * the init/close lifecycle. Underpins `createApp`'s plugin handling.
 */
export interface PluginContext {
  plugins: IgnexPlugin[];
  hooks: Map<string, HookFn[]>;
  addHook(name: string, hook: HookFn): void;
  getHooks(name: string): readonly HookFn[];
  register(plugin: IgnexPlugin): void;
  initAll(): Promise<void>;
  closeAll(): Promise<void>;
}

/**
 * Create an empty {@link PluginContext}.
 *
 * `initAll`/`closeAll` run every plugin's lifecycle with `allSettled`, so a
 * single plugin's failure never skips the rest (`closeAll` runs in reverse
 * registration order — onion cleanup).
 */
export const createPluginContext = (): PluginContext => {
  const hooks = new Map<string, HookFn[]>();
  const plugins: IgnexPlugin[] = [];

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
        if (r.status === "rejected") console.error("[ignex] plugin init failed:", r.reason);
      }
    },
    async closeAll() {
      // Reverse (onion) order: last registered closes first. allSettled ensures
      // one plugin's close failure never skips the remaining plugins' cleanup.
      const results = await Promise.allSettled([...plugins].reverse().map((p) => p.close?.()));
      for (const r of results) {
        if (r.status === "rejected") console.error("[ignex] plugin close failed:", r.reason);
      }
    },
  };
};

// ============================================================================
// Plugin Composition
// ============================================================================

/**
 * Compose multiple plugins into one, running their stages in onion order.
 *
 * `init` runs in registration order; `close`/`onResponse` in reverse.
 */
export const composePlugins = (...plugins: IgnexPlugin[]): IgnexPlugin => ({
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

function isIgnexPlugin(value: unknown): value is IgnexPlugin {
  return typeof value === "object" && value !== null && "name" in value;
}

/**
 * True when `value` is a thenable (Promise or PromiseLike). Lets the plugin
 * bridge hooks run synchronously in the common case (a sync `onRequest`/
 * `onResponse` that no-ops, e.g. cors without an Origin header) while still
 * awaiting genuinely async plugin hooks — ordering semantics are unchanged.
 */
const isThenable = <T>(value: T | PromiseLike<T> | undefined): value is PromiseLike<T> =>
  value != null && typeof (value as { then?: unknown }).then === "function";

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

/**
 * Convert a plugin list into lifecycle stage containers.
 *
 * `onRequest` plugins become a `request` stage, `onResponse` plugins are
 * composed into ONE `afterHandle` hook (so every plugin's response wrapping
 * runs — see the note in the implementation), and `onError` plugins become an
 * `error` stage. Non-plugin entries are filtered out.
 */
export const pluginsToLifeCycle = (plugins: unknown[]): Partial<LifeCycleStore> => {
  const list = (plugins ?? []).flat().filter(isIgnexPlugin);

  const request: HookContainer[] = list
    .filter((p) => typeof p.onRequest === "function")
    .map((p) => ({
      scope: "global" as const,
      // Deliberately NOT `async`: a synchronous onRequest (e.g. cors without
      // an Origin header, which no-ops) returns a plain `{ ctx }` with zero
      // Promise allocation. Genuinely async hooks are awaited via the thenable
      // branch, so ordering semantics are unchanged.
      fn: (ctx: IgnexContext) => {
        const result = p.onRequest?.(ctx);
        if (isThenable(result)) {
          return result.then((r) => {
            if (r instanceof Response) return { response: r };
            if (r) return { ctx: r };
            return { ctx };
          });
        }
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
            // Deliberately NOT `async`: when every onResponse plugin is
            // synchronous (e.g. security + cors, the comparison-bench plugins)
            // the chain runs with zero Promise allocation. If any plugin is
            // async, it and every later plugin are awaited sequentially, seeded
            // with the results already applied by the earlier synchronous
            // plugins — preserving the original in-order semantics exactly.
            fn: (ctx: IgnexContext, response: Response) => {
              let current: Response = response;
              for (let i = 0; i < onResponsePlugins.length; i++) {
                const result = onResponsePlugins[i].onResponse?.(ctx, current);
                if (!isThenable(result)) {
                  if (result instanceof Response) current = result;
                  continue;
                }
                // Async plugin at `i`: use its OWN promise as the chain head
                // (never re-invoke it), then defer every later plugin off the
                // chain sequentially. Earlier synchronous plugins already ran
                // and are baked into `current`. This mirrors the original
                // `await`-in-loop semantics with exactly one call per plugin.
                let chain = result.then((r) => (r instanceof Response ? r : current));
                for (let j = i + 1; j < onResponsePlugins.length; j++) {
                  const plugin = onResponsePlugins[j];
                  chain = chain.then(async (prev) => {
                    const r = await plugin.onResponse?.(ctx, prev);
                    return r instanceof Response ? r : prev;
                  });
                }
                return chain.then((final) => ({ response: final }));
              }
              return { response: current };
            },
          },
        ];

  const error: HookContainer[] = list
    .filter((p) => typeof p.onError === "function")
    .map((p) => ({
      scope: "global" as const,
      fn: async (ctx: IgnexContext, error: unknown) => {
        const result = await p.onError?.(
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
 * Wrap a single `HookFn` as a `IgnexPlugin` — the shared adapter behind the
 * auth / csrf / session plugin factories. An optional `close` callback is wired
 * to the plugin's `close()` so resources (stores, timers) are released on app
 * shutdown.
 */
export const hookToPlugin = (name: string, hook: HookFn, close?: () => void): IgnexPlugin => ({
  name,
  async onRequest(ctx) {
    const result = await hook(ctx);
    return result.ok ? result.ctx : result.response;
  },
  ...(close ? { close } : {}),
});

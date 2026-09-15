/**
 * @fileoverview Plugin Architecture v3.1
 * Lifecycle hooks, extensibility, composable plugins.
 */

import type { IgnexContext } from "../http/context";
import { sanitizeHeaderValue } from "../http/finalize";
import type { IgnexRouter } from "../http/router";
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
 *
 * Global middleware can be scoped to a route PATTERN: set `pattern` and the
 * plugin's `onRequest`/`onResponse` only run for matching request pathnames —
 * every other request skips the plugin entirely (zero hook cost beyond the
 * matcher check). Patterns are compiled once at plugin-conversion time.
 */
export interface IgnexPlugin {
  readonly name: string;
  readonly version?: string;

  /**
   * Route-pattern scope for the plugin's global middleware:
   *  - `string` — a path pattern (`"/api/admin/*"` prefix wildcard, `"/health"`
   *    exact). `"*"` matches everything (the default when unset).
   *  - `RegExp` — tested against the request pathname.
   *  - `(pathname) => boolean` — a custom predicate.
   *
   * Only `onRequest`/`onResponse` are scoped; `onError` and lifecycle hooks
   * are unscoped (errors have no meaningful path contract).
   */
  readonly pattern?: string | RegExp | ((pathname: string) => boolean);

  /**
   * Dev-only plugin marker: when `true` (the plugin factory determined it is
   * disabled at runtime — e.g. `debugbar()` outside debug mode), the compiled
   * server filters the plugin out of the lifecycle at boot, so a disabled dev
   * tool contributes zero per-request hooks to production artifacts.
   */
  readonly __ignexDevOnly?: boolean;

  /**
   * App-invariant response headers this plugin guarantees on every response.
   *
   * Declaring them lets the framework bake the values into the header record
   * at response CONSTRUCTION instead of the plugin mutating each finished
   * `Response` — replacing ~N native `Headers.set` round-trips per request
   * with one object build. The plugin's `onResponse` still runs for responses
   * the framework did not build (raw `Response` passthroughs) and for any
   * request-conditional headers it owns.
   */
  readonly responseDefaults?: Readonly<Record<string, string>>;

  /**
   * App-invariant context options this plugin requires.
   *
   * Declaring them lets ONE setting serve BOTH execution paths: the interpreted
   * `createApp` merges them into its context options at boot, and the compiled
   * server folds the same declaration into its frozen context-options literal.
   * Without this a plugin had no way to reach `ContextOptions` at all — which
   * is how `trustProxy` came to work in interpreted apps and be silently inert
   * in compiled ones: `ctx.ip` skipped the forwarded-header branch and every
   * client resolved to the socket address, i.e. the proxy's, behind a proxy.
   */
  readonly contextOptions?: { readonly trustProxy?: boolean };

  // Lifecycle
  init?(): MaybePromise<void>;
  close?(): MaybePromise<void>;

  /**
   * Register plugin routes onto the interpreted router. Called by `createApp`
   * once, before `router.bind(...)`, only when the app uses a router. Never
   * invoked for compiled (AOT) apps — plugins there contribute lifecycle
   * hooks only (see {@link IgnexPlugin.onRequest} for the compiled fallback).
   */
  routes?(router: IgnexRouter): void;

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
      // leave later plugins un-initialized. If any init failed, rethrow so
      // callers can fail CLOSED (`createApp({ strictInit: true })` never binds
      // the listener) — `Promise.allSettled` guarantees later plugins still
      // ran regardless.
      const results = await Promise.allSettled(plugins.map((p) => p.init?.()));
      const failures: unknown[] = [];
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("[ignex] plugin init failed:", r.reason);
          failures.push(r.reason);
        }
      }
      if (failures.length > 0) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, `${failures.length} plugin(s) failed to initialize`);
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
  routes(router) {
    for (const p of plugins) p.routes?.(router);
  },
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

interface PatternedPlugin {
  readonly plugin: IgnexPlugin;
  readonly match: (pathname: string) => boolean;
  /**
   * Boot-time constant: whether this plugin declared a `pattern` scope.
   *
   * Without it, the caller had to evaluate `ctx.url.pathname` BEFORE calling
   * `match` — forcing a full `new URL(req.url)` parse on every request purely
   * to feed an identity matcher that ignores its argument.
   */
  readonly hasPattern: boolean;
}

/**
 * Run the onion "way out" phase: every pattern-scoped `onResponse` plugin,
 * last-registered first. Pattern-scoped plugins are skipped for non-matching
 * pathnames; matching plugins may replace the response (pass-through when
 * they return `undefined`). Sync plugins run inline (zero Promise
 * allocation); the first async plugin seeds the deferred chain for the rest.
 */
const runOnResponseChain = (
  onResponsePlugins: readonly PatternedPlugin[],
): ((ctx: IgnexContext, response: Response) => unknown) => {
  // Boot-time constant: when no plugin declares a scope, the per-request
  // pathname is never read (it would force `ctx.url` → `new URL(req.url)`).
  const anyPattern = onResponsePlugins.some((e) => e.hasPattern);
  return (ctx: IgnexContext, response: Response): unknown => {
    // Only resolve a pathname when some plugin actually scopes on one. Uses
    // `ctx.path` (a cheap pathname slice) rather than `ctx.url.pathname`, which
    // would materialize a full `URL` — and only when a pattern exists at all.
    const pathname = anyPattern ? ctx.path : "";
    let current: Response = response;
    for (let i = 0; i < onResponsePlugins.length; i++) {
      const entry = onResponsePlugins[i];
      if (entry === undefined) continue;
      const { plugin, match } = entry;
      if (entry.hasPattern && !match(pathname)) continue; // pattern-scoped middleware
      const result = plugin.onResponse?.(ctx, current);
      if (!isThenable(result)) {
        if (result instanceof Response) current = result;
        continue;
      }
      // Async plugin at `i`: use its OWN promise as the chain head (never
      // re-invoke it), then defer every later plugin off the chain
      // sequentially. Earlier synchronous plugins already ran and are baked
      // into `current`. Mirrors the original await-in-loop semantics with
      // exactly one call per plugin.
      let chain = result.then((r) => (r instanceof Response ? r : current));
      for (let j = i + 1; j < onResponsePlugins.length; j++) {
        const later = onResponsePlugins[j];
        if (later === undefined) continue;
        chain = chain.then(async (prev) => {
          if (later.hasPattern && !later.match(pathname)) return prev;
          const r = await later.plugin.onResponse?.(ctx, prev);
          return r instanceof Response ? r : prev;
        });
      }
      return chain.then((final) => ({ response: final }));
    }
    return { response: current };
  };
};

/**
 * A route-pattern scope for global middleware (see {@link IgnexPlugin.pattern}).
 */
export type RoutePattern = string | RegExp | ((pathname: string) => boolean);

const escapeRegExpChars = (src: string): string => src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile a route pattern into a pathname matcher, ONCE per plugin:
 *  - `string` — exact (`"/health"`), prefix-wildcard (`"/api/admin/*"`, which
 *    also matches `/api/admin` itself), or internal wildcard (`"/files/*.ts"`).
 *    `"*"` matches every pathname.
 *  - `RegExp` — tested against the pathname (`lastIndex` reset so global/sticky
 *    flags never corrupt repeated tests).
 *  - `(pathname) => boolean` — a custom predicate.
 */
export const createPatternMatcher = (pattern?: RoutePattern): ((pathname: string) => boolean) => {
  if (pattern === undefined) return () => true;
  if (typeof pattern === "function") return pattern;
  if (pattern instanceof RegExp) {
    const re = pattern;
    return (pathname: string) => {
      re.lastIndex = 0;
      return re.test(pathname);
    };
  }
  if (pattern === "*") return () => true;
  if (!pattern.includes("*")) return (pathname: string) => pathname === pattern;

  const body = pattern.replace(/\/\*$/, "");
  if (body !== pattern) {
    // Trailing `/*` (or `*`) — prefix scope: the base path AND everything
    // below it match (`/api/admin`, `/api/admin/x`, `/api/admin/x/y`).
    const re = new RegExp(`^${escapeRegExpChars(body)}(?:/.*)?$`);
    return (pathname: string) => re.test(pathname);
  }
  // Internal wildcards: each `*` matches any run of non-slash chars.
  const re = new RegExp(`^${pattern.split("*").map(escapeRegExpChars).join("[^/]*")}$`);
  return (pathname: string) => re.test(pathname);
};

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
 * Merge the declarative `responseDefaults` of every plugin in the list.
 *
 * Called ONCE at app boot: the result is app-invariant, so `withBody` can bake
 * it into the header record of every framework-built response. Returns
 * `undefined` when no plugin declares any, keeping the response-construction
 * fast path branch-free and allocation-free.
 *
 * Values are sanitized HERE, once, because the per-request path applies this
 * record with `applyStaticHeaders` — which deliberately skips
 * `sanitizeHeaderValue` (and `Object.hasOwn`) for speed. Sanitizing at boot
 * keeps the response-splitting guarantee without paying for it per request.
 */
export const collectResponseDefaults = (
  plugins: readonly unknown[],
): Record<string, string> | undefined => {
  let merged: Record<string, string> | undefined;

  for (const p of (plugins ?? []).flat()) {
    if (!isIgnexPlugin(p)) continue;
    const defaults = p.responseDefaults;
    if (!defaults) continue;
    for (const k in defaults) {
      merged ??= {};
      merged[k] = sanitizeHeaderValue(String(defaults[k]));
    }
  }

  return merged === undefined ? undefined : Object.freeze(merged);
};

/**
 * Merge the declarative `contextOptions` of every plugin in the list.
 *
 * Sibling of {@link collectResponseDefaults}, and called the same way: ONCE at
 * app boot, because the values are app-invariant.
 *
 * A plugin can only ENABLE `trustProxy`, never disable it — the setting means
 * "forwarded headers are authoritative for this deployment", so one plugin
 * declaring it settles the question and no plugin can prove the opposite.
 * Returns `undefined` when nothing is declared, leaving an explicit app-level
 * option authoritative.
 *
 * The compiled server folds the same declaration at boot from the plugin
 * objects it already has (see `phases/codegen/header.ts`), so both paths agree.
 *
 * @param plugins - The app's plugin list (nested arrays are flattened).
 * @returns The merged options, or `undefined` when no plugin declares any.
 */
export const collectContextOptions = (
  plugins: readonly unknown[],
): { trustProxy?: boolean } | undefined => {
  let trustProxy: boolean | undefined;

  for (const p of (plugins ?? []).flat()) {
    if (!isIgnexPlugin(p)) continue;
    if (p.contextOptions?.trustProxy === true) trustProxy = true;
  }

  return trustProxy === undefined ? undefined : Object.freeze({ trustProxy });
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
  // Dev-only plugins that are disabled at runtime (`__ignexDevOnly: true`,
  // e.g. `debugbar()` outside debug mode) contribute no lifecycle hooks —
  // mirroring the compiled server's boot-time filter, so interpreted apps pay
  // zero per-request hook costs for a disabled dev tool too.
  const list = (plugins ?? [])
    .flat()
    .filter(isIgnexPlugin)
    .filter((p) => p.__ignexDevOnly !== true);

  const request: HookContainer[] = list
    .filter((p) => typeof p.onRequest === "function")
    .map((p) => {
      // Pattern-scoped global middleware: the matcher is compiled ONCE; a
      // non-matching request skips the plugin with a plain `{ ctx }` (the
      // cheapest possible pass-through).
      const hasPattern = p.pattern !== undefined;
      const match = createPatternMatcher(p.pattern);
      const onRequest = p.onRequest;
      return {
        scope: "global" as const,
        // Deliberately NOT `async`: a synchronous onRequest (e.g. cors without
        // an Origin header, which no-ops) returns a plain `{ ctx }` with zero
        // Promise allocation. Genuinely async hooks are awaited via the thenable
        // branch, so ordering semantics are unchanged.
        fn: (ctx: IgnexContext) => {
          // `hasPattern` is a boot-time constant, so an unscoped plugin never
          // evaluates a pathname at all; `ctx.path` (a slice) is used rather
          // than `ctx.url.pathname` (a full `URL` parse) when it does.
          if (hasPattern && !match(ctx.path)) return { ctx };
          const result = onRequest?.(ctx);
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
      };
    });

  const onResponsePlugins = [...list]
    .reverse()
    .filter((p) => typeof p.onResponse === "function")
    .map((p) => ({
      plugin: p,
      match: createPatternMatcher(p.pattern),
      hasPattern: p.pattern !== undefined,
    }));

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
            fn: runOnResponseChain(onResponsePlugins),
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
 *
 * Sync-capable: a hook that returns synchronously (e.g. lazy session on a
 * request that never touches a session) yields a plain `{ ctx }` with ZERO
 * Promise allocation — only genuinely async hooks return a Promise (which
 * `runHooks`/the compiled sync core await via its resume path).
 */
export const hookToPlugin = (name: string, hook: HookFn, close?: () => void): IgnexPlugin => ({
  name,
  onRequest(ctx) {
    const result = hook(ctx);
    if (result instanceof Promise) {
      return result.then((r) => (r.ok ? r.ctx : r.response));
    }
    return result.ok ? result.ctx : result.response;
  },
  ...(close ? { close } : {}),
});

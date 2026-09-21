/**
 * @fileoverview Plugin Architecture — interfaces and types.
 *
 * The plugin contract (`IgnexPlugin`), the runtime registry surface
 * (`PluginContext`), route-pattern scopes (`RoutePattern`) and the internal
 * pattern-scoped entry shape used by the lifecycle bridge. Type-only module —
 * no runtime code — so every other plugin file can depend on it freely.
 */

import type { ContextUsage } from "@ignex/shared";
import type { IgnexContext } from "../../http/context";
import type { IgnexRouter } from "../../http/router";
import type { HookFn } from "../hooks";

type MaybePromise<T> = T | Promise<T>;

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

  /**
   * The `ctx` members this plugin's hooks read or write.
   *
   * Declaring them lets the COMPILED server run the plugin layer on the
   * usage-specialized context (see `packages/compiler/.../routes/context.ts`)
   * instead of forcing every route to the full context — the declaration is
   * the missing "plugin-API" piece of that optimization.
   *
   * The compiler cannot execute plugin factories, so for compiled builds the
   * same declaration is read STATICALLY from the plugin module (a module-level
   * `export const contextUsage = { ... }`). The module export is the audited,
   * machine-readable form and wins when both exist; this field is the
   * runtime-visible API surface (introspection, interpreted tooling).
   *
   * Optional and opt-in. An UNDECLARED plugin keeps today's behavior: the
   * compiler treats the plugin layer as opaque and every route uses the full
   * context. A declared member the specialized context cannot emit also forces
   * the full context (fail-safe — never a silent `undefined` on the lean
   * tier). Only `true` values are meaningful; a `false`/`undefined` value
   * reads as "not used".
   */
  readonly contextUsage?: Readonly<Partial<ContextUsage>>;

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
 * A route-pattern scope for global middleware (see {@link IgnexPlugin.pattern}).
 */
export type RoutePattern = string | RegExp | ((pathname: string) => boolean);

/**
 * A pattern-scoped `onResponse` plugin with its matcher compiled ONCE at boot.
 *
 * @internal Only used by the lifecycle bridge (`pluginsToLifeCycle`).
 */
export interface PatternedPlugin {
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

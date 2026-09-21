/**
 * @fileoverview App creation options + the app-invariant context options for
 * the interpreted server. The cache, proxy-trust flag, and advisory
 * `maxHeaderBytes` gate are all fixed once at `createApp` time and must stay
 * out of the per-request hot path. Extracted from `createApp`, which sits at
 * the cognitive-complexity ceiling.
 */

import type { HttpResponseCache } from "../data/cache";
import type { ContextOptions, IgnexContext } from "../http/context";
import type { IgnexRouter } from "../http/router";
import type { LifeCycleStore, MaybePromise } from "../types";
import { collectContextOptions, type IgnexPlugin } from "./plugin";

/** Creation options for {@link IgnexApp} (see `lifecycle/app-factory`). */
export interface AppOptions {
  /** Lifecycle hooks (merged after plugin hooks). */
  lifecycle?: Partial<LifeCycleStore>;
  plugins?: IgnexPlugin[];
  /**
   * The base handler receiving the resolved context. Required UNLESS a
   * `router` is provided (routed apps dispatch per-route handlers instead).
   */
  handler?(ctx: IgnexContext): MaybePromise<Response>;
  /**
   * Optional interpreted router (see `createRouter`). When present, `serve()`
   * builds a Bun-native `routes` table from it (Rust path/method matching —
   * no JS per-request scan) and `handler()` dispatches through it. Without a
   * router, every request reaches the single `handler`.
   */
  router?: IgnexRouter;
  onStart?(): MaybePromise<void>;
  onStop?(): MaybePromise<void>;
  /** Expose error details in 500 responses. */
  exposeErrors?: boolean;
  /**
   * Fail CLOSED on plugin `init` errors. Default (best-effort) logs a rejected
   * `init` and keeps serving. With `strictInit: true`, a failed init stops the
   * listener so the app never serves in a half-initialized state (e.g. a DB
   * connection that failed at boot) — the process should be restarted after
   * the underlying issue is fixed.
   */
  strictInit?: boolean;
  /**
   * App-scoped response cache for `ctx.cache()`. Defaults to a fresh cache
   * scoped to this app; pass one here to share a specific cache.
   */
  cache?: HttpResponseCache;
  /** Trust `x-real-ip` / `x-forwarded-for` when `server.requestIP` is unavailable. */
  trustProxy?: boolean;
  /**
   * Advisory per-request header-size ceiling in bytes; see
   * {@link ContextOptions.maxHeaderBytes}. Unset by default — Bun's
   * socket-level header limits stay the authority unless an app opts in.
   */
  maxHeaderBytes?: number;
}

/**
 * Resolve this app's `trustProxy` setting, or `undefined` when nothing sets it.
 *
 * An explicit app-level option wins; otherwise a plugin's declaration applies
 * (see `IgnexPlugin.contextOptions`, which `security({ trustProxy: true })` now
 * carries). Either way the value has to equal what the compiled server folds
 * into its frozen context-options literal, or `ctx.ip` would resolve
 * differently in a compiled build than in an interpreted one.
 *
 * @param options - The app options the app was created with.
 * @returns The setting, or `undefined` to leave it unset.
 */
const resolveTrustProxy = (options: AppOptions): boolean | undefined => {
  if (options.trustProxy !== undefined) return options.trustProxy;
  return collectContextOptions(options.plugins ?? [])?.trustProxy;
};

/**
 * Populate the app-invariant context options once at `createApp` time.
 *
 * Cache, proxy trust and the advisory `maxHeaderBytes` gate are all fixed at
 * creation and must stay out of the per-request hot path.
 *
 * @param options - The app options the app was created with.
 * @param appCache - The app-scoped response cache.
 * @returns The pre-computed context options for every request the app serves.
 */
export const buildContextOptions = (
  options: AppOptions,
  appCache: HttpResponseCache,
): ContextOptions => {
  const ctxOptions: ContextOptions = { cache: appCache };
  const trustProxy = resolveTrustProxy(options);
  if (trustProxy !== undefined) ctxOptions.trustProxy = trustProxy;
  if (options.maxHeaderBytes !== undefined) ctxOptions.maxHeaderBytes = options.maxHeaderBytes;
  return ctxOptions;
};

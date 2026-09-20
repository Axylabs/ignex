/**
 * @fileoverview Ignex Context — public interfaces and types.
 *
 * The type surface of the per-request object: the narrow `IgnexServer` view,
 * the `ContextOptions` plumbing, and the `IgnexContext` contract handlers and
 * hooks receive. Kept free of runtime code so both `impl.ts` (interpreted
 * path) and the compiled server can depend on the same shapes.
 */

import type { HttpResponseCache, HttpResponseCacheOptions } from "../../data/cache";
import type { DataLoaderFactory } from "../../data/dataloader";
import type { DebugApi } from "../../debug/types";
import type { HttpMethod } from "../../types";
import type { LazyBody, LazyBodyOptions } from "../body";
import type { Cookie } from "../cookies";
import type { SendFileOptions } from "../files";
import type { SetHeaders } from "../headers";
import type { ProxyOptions } from "../proxy";

/**
 * Narrow, Bun-free view of the server handle exposed on {@link IgnexContext}.
 *
 * The generated server assigns the Bun `Server` instance here; this structural
 * subset is all the runtime reads (client IP lookup). Keeping it Bun-free lets
 * `@ignex/core` typecheck under non-Bun tsconfigs (e.g. the CLI's `types:
 * ["node"]`).
 */
export interface IgnexServer {
  requestIP(req: Request): { address: string; family?: string; port?: number } | null;
  /**
   * Upgrade an HTTP request to a WebSocket (Bun `Server.upgrade`). Optional
   * so non-Bun runtimes / the interpreted path degrade to `false` in
   * {@link upgradeWS}. The generated server assigns the real Bun server here.
   */
  upgrade?(
    req: Request,
    options?: { data?: unknown; headers?: Headers | Record<string, string> },
  ): boolean;
}

/**
 * Options for {@link createContext}: pre-computed request data plus runtime
 * wiring (route pattern, cache, proxy trust).
 */
export interface ContextOptions {
  query?: URLSearchParams;
  body?: LazyBodyOptions;
  bodyInstance?: LazyBody;
  params?: Record<string, string>;
  set?: Partial<SetHeaders>;
  /**
   * App-invariant response headers applied when the framework builds a
   * response (`ctx.json`/`ctx.text`/`ctx.html`).
   *
   * Populated once at app boot from the plugins' declarative
   * `responseDefaults` (see {@link IgnexPlugin.responseDefaults}) — currently
   * the `security()` header set. Baking them into the header record at
   * construction turns a per-request chain of ~8 native `Headers.set` calls
   * (the dominant cost of the security plugin) into a single object build.
   */
  responseDefaults?: Record<string, string>;
  /**
   * Matched route pattern (e.g. `/users/:id`). The AOT-compiled server
   * threads the pattern it matched; the interpreted `createApp` path has no
   * router and leaves this unset ("").
   */
  route?: string;
  /**
   * App-scoped response cache. When omitted, `ctx.cache` shares a single
   * process-wide cache across every app in the process (keyed by method+URL).
   * Pass a dedicated `HttpResponseCache` per app to scope entries.
   */
  cache?: HttpResponseCache;
  /**
   * Trust `x-real-ip` / `x-forwarded-for` when `server.requestIP` is
   * unavailable. Off by default — blindly trusting client-supplied headers is
   * spoofable (it feeds rate limiting / access logs).
   */
  trustProxy?: boolean;
}

/**
 * The per-request context passed to handlers and hooks.
 *
 * `P`/`Q`/`B` are the inferred `params`/`query`/`body` types from the route
 * schema. Response helpers (`json`/`text`/`html`/…) and the outbound `set`
 * accumulator are the primary write surface; `sendFile`/`proxy`/`forward`/
 * `cache`/`loader` are the extended capabilities.
 */
export interface IgnexContext<P = Record<string, string>, Q = URLSearchParams, B = unknown> {
  readonly req: Request;
  readonly url: URL;
  readonly method: HttpMethod;
  readonly path: string;
  readonly route: string;
  readonly headers: Headers;
  readonly requestId: string;
  readonly startTime: number;
  readonly ip: string;

  params: P;
  query: Q;
  /** Request body. The `B` type parameter is preserved for API compatibility. */
  body: LazyBody & (B extends unknown ? unknown : never);
  cookie: Record<string, Cookie<string | undefined>>;

  /**
   * Outgoing channel: headers, status, redirect and cookie mutations are
   * accumulated here and applied to the final response by the runtime
   * (`__applySet` in the generated server).
   */
  readonly set: SetHeaders;

  state: Map<string | symbol, unknown>;

  getState<T = unknown>(key: string | symbol): T | undefined;
  setState<T>(key: string | symbol, value: T): void;

  json<T>(data: T, init?: ResponseInit): Response;
  text(data: string, init?: ResponseInit): Response;
  html(data: string, init?: ResponseInit): Response;
  redirect(url: string, status?: 301 | 302 | 303 | 307 | 308): Response;
  stream(stream: ReadableStream, init?: ResponseInit): Response;
  empty(status?: number): Response;
  status(code: number): Response;

  sendFile(path: string, opts?: SendFileOptions): Promise<Response>;
  proxy(target: string | URL, opts?: ProxyOptions): Promise<Response>;
  forward(target: string | URL, opts?: ProxyOptions): Promise<Response>;

  /**
   * Cache the response of `factory` keyed by method+URL (+ `vary` headers).
   *
   * Requests carrying an `Authorization` header bypass the cache unless
   * `allowAuthorized: true`; cookie-bearing requests bypass it unless
   * `vary: ["cookie"]` (per-cookie keys) or `allowCookies: true`. This
   * prevents authenticated responses from leaking across users through a
   * shared key.
   */
  cache(
    factory: () => Promise<Response>,
    opts?: HttpResponseCacheOptions & {
      vary?: string[];
      allowAuthorized?: boolean;
      allowCookies?: boolean;
    },
  ): Promise<Response>;

  /**
   * Create a per-request DataLoader (batching + caching + dedup). Loaders
   * created here live for the duration of this request.
   */
  readonly loader: DataLoaderFactory;

  /**
   * Debug tracing API (span / query / cache / http / error recording), injected
   * by the `debugbar()` plugin. Always present: it is a shared no-op unless the
   * plugin replaced it for this request, so handlers can call `ctx.debug.*`
   * unconditionally and pay nothing in production.
   */
  readonly debug: DebugApi;

  /**
   * The Bun server backing this request, wired by `createApp().serve()` and
   * the compiled server (which emits `ctx.server = server`). Used by `ctx.ip`
   * for the real socket address. Mutable so the framework can inject it.
   */
  server: IgnexServer | null;
}

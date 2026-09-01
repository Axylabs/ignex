/**
 * @fileoverview Ignex Context — the per-request object and its factory.
 *
 * Bun 1.4 edition. Optimizations:
 * - lazy cookie parsing (delegated to `./cookies`)
 * - lazy state map
 * - `ctx.ip` using Bun server.requestIP when available
 *
 * The response channel (`set`/`applySet`), cookies and request-id generation
 * live in their own focused modules (`./headers`, `./cookies`, `./request-id`).
 */

import { HttpResponseCache, type HttpResponseCacheOptions } from "../data/cache";
import { createDataLoader, type DataLoaderFactory } from "../data/dataloader";
import { createQueryParams } from "../data/query";
import { NOOP_DEBUG_API } from "../debug/api";
import type { DebugApi } from "../debug/types";
import { lastForwardedIp } from "../platform/coerce";
import type { ElysiaCookie, HttpMethod } from "../types";
import { createLazyBody, type LazyBody, type LazyBodyOptions } from "./body";
import { type Cookie, createLazyCookieJar } from "./cookies";
import { type SendFileOptions, sendFile } from "./files";
import { createResponseInit, responseWithBody, type SetHeaders } from "./headers";
import { forwardRequest, type ProxyOptions, proxyRequest } from "./proxy";
import { generateRequestId } from "./request-id";

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

/**
 * Cheap pathname extraction from an absolute request URL without allocating a
 * full `URL` object. Equivalent to `new URL(url).pathname` for the absolute
 * URLs Bun's `Request.url` carries (e.g. `http://host:3000/api/users?x=1`):
 * the path is the percent-encoded substring after the authority, cut at the
 * first `?` or `#` (never decoded), with a bare authority mapping to `/`.
 */
const pathnameOf = (url: string): string => {
  const schemeEnd = url.indexOf("://");
  const start =
    schemeEnd === -1
      ? url.startsWith("//")
        ? url.indexOf("/", 2)
        : 0
      : url.indexOf("/", schemeEnd + 3);
  if (start === -1) return "/";

  let end = url.length;
  const query = url.indexOf("?", start);
  const fragment = url.indexOf("#", start);
  if (query !== -1 && query < end) end = query;
  if (fragment !== -1 && fragment < end) end = fragment;

  const path = url.slice(start, end);
  return path === "" ? "/" : path;
};

const defaultCache = new HttpResponseCache({
  max: 1000,
  ttlMs: 60_000,
  staleTtlMs: 300_000,
});

/**
 * Shared per-request context implementation — the "cached context" pattern.
 *
 * All methods + getters live on the prototype (created ONCE), so each request
 * only allocates the instance DATA fields instead of ~25 closures from the old
 * object literal. This is the biggest single per-request JS cost in the
 * `needsFull` compiled path and the interpreted `createApp` path.
 */
class IgnexContextImpl<P = Record<string, string>> implements IgnexContext<P, URLSearchParams> {
  readonly req: Request;
  readonly method: HttpMethod;
  readonly route: string;
  readonly headers: Headers;
  params: P;
  readonly set: SetHeaders;
  readonly startTime: number;
  server: IgnexServer | null = null;

  /**
   * Debug API — a shared no-op by default (prototype getter: ZERO per-instance
   * cost; the `debugbar()` plugin swaps in a per-request API via
   * `Object.defineProperty` when it starts a trace in debug mode).
   */
  get debug(): DebugApi {
    return NOOP_DEBUG_API;
  }

  private _body: LazyBody | undefined;
  private _cookie: Record<string, Cookie<string | undefined>> | undefined;
  private _url: URL | undefined;
  private _path: string | undefined;
  private _query:
    | URLSearchParams
    | Record<string, string | string[]>
    | import("../data/query").NativeQueryParams
    | undefined;
  private _requestId: string | undefined;
  private _ip: string | undefined;
  private _state: Map<string | symbol, unknown> | undefined;
  private readonly _opts: ContextOptions;

  constructor(req: Request, params: P, opts: ContextOptions = {}) {
    this.req = req;
    this.method = req.method as HttpMethod;
    this.route = opts.route ?? "";
    this.headers = req.headers;
    this.params = params;
    // `body` and `cookie` are created LAZILY on first access (getters below),
    // so a request that never reads the body or cookies pays zero setup cost.
    // Previously `createLazyBody` (~300ns) + the cookie-jar proxy (~52ns) were
    // allocated eagerly on every full-context request, even GET routes that
    // never touch either. `startTime` stays eager: it must capture the request
    // START (the access-log/logger duration = now − startTime).
    this._body = opts.bodyInstance;
    // `status` is intentionally left unset: an explicitly-set `set.status`
    // overrides the response status (see `applySet`), but a default of 200
    // here would clobber handlers returning e.g. 401/redirects.
    this.set = { headers: Object.create(null), ...opts.set };
    // The `set.cookie` accumulator is always initialized so handlers can write
    // `ctx.set.cookie.name = {...}` directly even when they never read
    // `ctx.cookie` (the cookie-jar PROXY is created lazily on first `ctx.cookie`
    // access — previously the eager jar creation did this initialization).
    if (this.set.cookie === undefined) {
      this.set.cookie = Object.create(null) as Record<string, ElysiaCookie>;
    }
    this.startTime = performance.now();
    this._opts = opts;
    this._query = opts.query;
  }

  get body(): LazyBody {
    if (this._body === undefined) {
      this._body = createLazyBody(this.req, this._opts.body);
    }
    return this._body;
  }

  set body(value: LazyBody) {
    this._body = value;
  }

  get cookie(): Record<string, Cookie<string | undefined>> {
    if (this._cookie === undefined) {
      this._cookie = createLazyCookieJar(this.set, () => this.req.headers.get("cookie"));
    }
    return this._cookie;
  }

  set cookie(value: Record<string, Cookie<string | undefined>>) {
    this._cookie = value;
  }

  get url(): URL {
    if (this._url === undefined) {
      this._url = new URL(this.req.url);
    }
    return this._url;
  }

  get path(): string {
    // Cheap pathname extraction — independent of `url` so a request that only
    // routes on the path (e.g. /health, /api/echo) never allocates a URL.
    if (this._path === undefined) {
      this._path = pathnameOf(this.req.url);
    }
    return this._path;
  }

  get requestId(): string {
    if (this._requestId === undefined) {
      this._requestId = generateRequestId();
    }
    return this._requestId;
  }

  get ip(): string {
    if (this._ip !== undefined) return this._ip;

    const server = this.server;

    try {
      const socketIp = server?.requestIP?.(this.req)?.address;
      if (socketIp) {
        this._ip = socketIp;
        return socketIp;
      }
    } catch (err) {
      // `requestIP` is non-standard on some runtimes and may throw rather
      // than return undefined — surface it at info level instead of
      // silently masking the failure, then fall through to headers.
      console.info("[ignex] requestIP unavailable:", err);
    }

    // Client-supplied IP headers are spoofable; only honor them when the app
    // explicitly opts into trusting a proxy in front.
    if (this._opts.trustProxy) {
      const forwarded =
        this.req.headers.get("x-real-ip") ??
        lastForwardedIp(this.req.headers.get("x-forwarded-for"));
      if (forwarded) {
        this._ip = forwarded;
        return forwarded;
      }
    }

    this._ip = "anonymous";
    return "anonymous";
  }

  get query(): URLSearchParams {
    if (this._query === undefined) {
      // Parse the query substring ONCE. `createQueryParams` uses the native
      // pairs parse + `NativeQueryParams` when the addon is loaded (~4× faster
      // than URLSearchParams on a 20-parameter query, same read contract) and
      // falls back to `new URLSearchParams(substring)` otherwise — itself an
      // optimization over `new URL(url).searchParams` (~1.15×, no full URL
      // object parse; HTTP request URLs carry no `#` fragment).
      const url = this.req.url;
      const q = url.indexOf("?");
      this._query = q === -1 ? new URLSearchParams() : createQueryParams(url.slice(q + 1));
    }
    return this._query as URLSearchParams;
  }

  set query(value: URLSearchParams | Record<string, string | string[]>) {
    // The compiler prelude shadows `ctx.query` with the parsed/validated
    // Record (previously a per-request `Object.defineProperty`, which is ~8x
    // slower than a plain assignment through this setter). Observable reads
    // are identical: after the prelude, `ctx.query` IS the Record.
    this._query = value;
  }

  get state(): Map<string | symbol, unknown> {
    if (this._state === undefined) {
      this._state = new Map<string | symbol, unknown>();
    }
    return this._state;
  }

  getState<T = unknown>(key: string | symbol): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  setState<T>(key: string | symbol, value: T): void {
    this.state.set(key, value);
  }

  get loader(): DataLoaderFactory {
    return createDataLoader;
  }

  json<T>(data: T, init?: ResponseInit): Response {
    const status = init?.status ?? this.set.status ?? 200;
    const s = JSON.stringify(data);

    return responseWithBody(s === undefined ? undefined : s, "application/json; charset=utf-8", {
      ...init,
      status,
    });
  }

  text(data: string, init?: ResponseInit): Response {
    const status = init?.status ?? this.set.status ?? 200;

    return responseWithBody(String(data), "text/plain; charset=utf-8", {
      ...init,
      status,
    });
  }

  html(data: string, init?: ResponseInit): Response {
    const status = init?.status ?? this.set.status ?? 200;

    return responseWithBody(String(data), "text/html; charset=utf-8", {
      ...init,
      status,
    });
  }

  stream(stream: ReadableStream, init?: ResponseInit): Response {
    return new Response(stream, createResponseInit(init?.status ?? 200, init?.headers));
  }

  empty(status = 204): Response {
    return new Response(null, { status });
  }

  status(code: number): Response {
    return new Response(null, { status: code });
  }

  sendFile(path: string, sendOpts: SendFileOptions = {}) {
    return sendFile(path, { req: this.req, ...sendOpts });
  }

  proxy(target: string | URL, proxyOpts: ProxyOptions = {}) {
    return proxyRequest(target, proxyOpts);
  }

  forward(target: string | URL, proxyOpts: ProxyOptions = {}) {
    return forwardRequest(this.req, target, proxyOpts);
  }

  cache(factory: () => Promise<Response>, cacheOpts = {}) {
    return (this._opts.cache ?? defaultCache).getOrSet(this.req, factory, cacheOpts);
  }

  redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
    // Build the redirect manually rather than `Response.redirect()`: the
    // standard helper requires an *absolute* URL and throws on relative
    // `Location` values in some runtimes (e.g. undici under vitest), while
    // relative redirects are the common case (`/login`, `/home`). Setting
    // the Location header directly is runtime-agnostic (matches Fastify).
    return new Response(null, {
      status,
      headers: { location: url },
    });
  }
}

/**
 * Create a per-request context.
 *
 * `params` are the matched route params; `opts` supplies the pre-parsed query,
 * body instance/options, route pattern, cache and proxy-trust settings. Used
 * by `createApp` (interpreted) and the compiler-generated server.
 */
export function createContext<P = Record<string, string>>(
  req: Request,
  params: P,
  opts: ContextOptions = {},
): IgnexContext<P, URLSearchParams> {
  return new IgnexContextImpl(req, params, opts);
}

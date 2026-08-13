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
import { firstForwardedIp } from "../platform/coerce";
import type { HttpMethod } from "../types";
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
  readonly query: Q;
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

  cache(
    factory: () => Promise<Response>,
    opts?: HttpResponseCacheOptions & { vary?: string[] },
  ): Promise<Response>;

  /**
   * Create a per-request DataLoader (batching + caching + dedup). Loaders
   * created here live for the duration of this request.
   */
  readonly loader: DataLoaderFactory;

  readonly server: IgnexServer | null;
}

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
  body: LazyBody;
  cookie: Record<string, Cookie<string | undefined>>;
  readonly set: SetHeaders;
  readonly startTime: number;
  server: IgnexServer | null = null;

  private _url: URL | undefined;
  private _query: URLSearchParams | undefined;
  private _requestId: string | undefined;
  private _state: Map<string | symbol, unknown> | undefined;
  private readonly _opts: ContextOptions;

  constructor(req: Request, params: P, opts: ContextOptions = {}) {
    this.req = req;
    this.method = req.method as HttpMethod;
    this.route = opts.route ?? "";
    this.headers = req.headers;
    this.params = params;
    this.body = opts.bodyInstance ?? createLazyBody(req, opts.body);
    // `status` is intentionally left unset: an explicitly-set `set.status`
    // overrides the response status (see `applySet`), but a default of 200
    // here would clobber handlers returning e.g. 401/redirects.
    this.set = { headers: {}, ...opts.set };
    this.cookie = createLazyCookieJar(this.set, () => this.req.headers.get("cookie"));
    this.startTime = performance.now();
    this._opts = opts;
    this._query = opts.query;
  }

  get url(): URL {
    if (this._url === undefined) {
      this._url = new URL(this.req.url);
    }
    return this._url;
  }

  get path(): string {
    return this.url.pathname;
  }

  get requestId(): string {
    if (this._requestId === undefined) {
      this._requestId = generateRequestId();
    }
    return this._requestId;
  }

  get ip(): string {
    const server = this.server;

    try {
      const socketIp = server?.requestIP?.(this.req)?.address;
      if (socketIp) return socketIp;
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
        firstForwardedIp(this.req.headers.get("x-forwarded-for"));
      if (forwarded) return forwarded;
    }

    return "anonymous";
  }

  get query(): URLSearchParams {
    if (this._query === undefined) {
      this._query = this.url.searchParams;
    }
    return this._query;
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

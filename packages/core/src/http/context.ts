/**
 * @fileoverview Flux Context — the per-request object and its factory.
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
import {
  createResponseInit,
  HDR_HTML,
  HDR_JSON,
  HDR_TEXT,
  mergeHeaders,
  type SetHeaders,
} from "./headers";
import { forwardRequest, type ProxyOptions, proxyRequest } from "./proxy";
import { generateRequestId } from "./request-id";

/**
 * Narrow, Bun-free view of the server handle exposed on {@link FluxContext}.
 *
 * The generated server assigns the Bun `Server` instance here; this structural
 * subset is all the runtime reads (client IP lookup). Keeping it Bun-free lets
 * `@flux/core` typecheck under non-Bun tsconfigs (e.g. the CLI's `types:
 * ["node"]`).
 */
export interface FluxServer {
  requestIP(req: Request): { address: string; family?: string; port?: number } | null;
}

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

export interface FluxContext<P = Record<string, string>, Q = URLSearchParams, B = unknown> {
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

  readonly server: FluxServer | null;
}

const defaultCache = new HttpResponseCache({
  max: 1000,
  ttlMs: 60_000,
  staleTtlMs: 300_000,
});

export function createContext<P = Record<string, string>>(
  req: Request,
  params: P,
  opts: ContextOptions = {},
): FluxContext<P, URLSearchParams> {
  let _url: URL | undefined;
  let _query: URLSearchParams | undefined = opts.query;

  const body = opts.bodyInstance ?? createLazyBody(req, opts.body);

  let state: Map<string | symbol, unknown> | undefined;

  const ensureState = () => {
    if (!state) {
      state = new Map<string | symbol, unknown>();
    }

    return state;
  };

  // `status` is intentionally left unset: an explicitly-set `set.status`
  // overrides the response status (see `applySet`), but a default of 200 here
  // would clobber handlers returning e.g. 401/redirects. `json`/`text`/`html`
  // fall back to 200 themselves.
  const set: SetHeaders = { headers: {}, ...opts.set };

  const cookie = createLazyCookieJar(set, () => req.headers.get("cookie"));

  const ctx: FluxContext<P, URLSearchParams> = {
    req,

    get url() {
      return (_url ??= new URL(req.url));
    },

    method: req.method as HttpMethod,

    get path() {
      return this.url.pathname;
    },

    route: opts.route ?? "",
    headers: req.headers,
    requestId: generateRequestId(),
    startTime: performance.now(),

    get ip(): string {
      const server = this.server;

      try {
        const socketIp = server?.requestIP?.(req)?.address;
        if (socketIp) return socketIp;
      } catch (err) {
        // `requestIP` is non-standard on some runtimes and may throw rather
        // than return undefined — surface it at info level instead of
        // silently masking the failure, then fall through to headers.
        console.info("[flux] requestIP unavailable:", err);
      }

      // Client-supplied IP headers are spoofable; only honor them when the app
      // explicitly opts into trusting a proxy in front.
      if (opts.trustProxy) {
        const forwarded =
          req.headers.get("x-real-ip") ?? firstForwardedIp(req.headers.get("x-forwarded-for"));
        if (forwarded) return forwarded;
      }

      return "anonymous";
    },

    params,

    get query() {
      return (_query ??= this.url.searchParams) as URLSearchParams;
    },

    body,
    cookie,
    set,

    get state() {
      return ensureState();
    },

    getState<T = unknown>(key: string | symbol): T | undefined {
      return ensureState().get(key) as T | undefined;
    },

    setState<T>(key: string | symbol, value: T): void {
      ensureState().set(key, value);
    },

    json<T>(data: T, init?: ResponseInit): Response {
      const status = init?.status ?? set.status ?? 200;

      return Response.json(data, {
        status,
        headers: mergeHeaders(HDR_JSON, init?.headers),
      });
    },

    text(data: string, init?: ResponseInit): Response {
      const status = init?.status ?? set.status ?? 200;

      return new Response(data, {
        status,
        headers: mergeHeaders(HDR_TEXT, init?.headers),
      });
    },

    html(data: string, init?: ResponseInit): Response {
      const status = init?.status ?? set.status ?? 200;

      return new Response(data, {
        status,
        headers: mergeHeaders(HDR_HTML, init?.headers),
      });
    },

    stream(stream: ReadableStream, init?: ResponseInit): Response {
      return new Response(stream, createResponseInit(init?.status ?? 200, init?.headers));
    },

    empty(status = 204): Response {
      return new Response(null, { status });
    },

    status(code: number): Response {
      return new Response(null, { status: code });
    },

    sendFile(path: string, sendOpts: SendFileOptions = {}) {
      return sendFile(path, { req, ...sendOpts });
    },

    proxy(target: string | URL, proxyOpts: ProxyOptions = {}) {
      return proxyRequest(target, proxyOpts);
    },

    forward(target: string | URL, proxyOpts: ProxyOptions = {}) {
      return forwardRequest(req, target, proxyOpts);
    },

    cache(factory: () => Promise<Response>, cacheOpts = {}) {
      return (opts.cache ?? defaultCache).getOrSet(req, factory, cacheOpts);
    },

    loader: createDataLoader,

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
    },

    server: null,
  };

  return ctx;
}

/**
 * @fileoverview Ignex Context — the shared per-request implementation.
 *
 * The "cached context" pattern: all methods + getters live on a single
 * prototype, so each request only allocates the instance DATA fields instead
 * of ~25 closures per request. This is the biggest single per-request JS cost
 * in the `needsFull` compiled path and the interpreted `createApp` path.
 */

import { HttpResponseCache } from "../../data/cache";
import { createDataLoader, type DataLoaderFactory } from "../../data/dataloader";
import { createQueryParams } from "../../data/query";
import { NOOP_DEBUG_API } from "../../debug/api";
import type { DebugApi } from "../../debug/types";
import type { ElysiaCookie, HttpMethod } from "../../types";
import { createLazyBody, type LazyBody } from "../body";
import { type Cookie, createLazyCookieJar } from "../cookies";
import { type SendFileOptions, sendFile } from "../files";
import { createResponseInit, responseWithBody, type SetHeaders } from "../headers";
import { forwardRequest, type ProxyOptions, proxyRequest } from "../proxy";
import { generateRequestId } from "../request-id";
import { consumeSetHeaders, emptyHeaders, pathnameOf, resolveClientIp } from "./helpers";
import type { ContextOptions, IgnexContext, IgnexServer } from "./types";

/**
 * App-scoped fallback response cache: `HttpResponseCache` shared across every
 * app in the process when a route never passes a dedicated cache via
 * {@link ContextOptions.cache}.
 */
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
 *
 * @internal Not part of the public surface — see {@link createContext} for the
 * factory and {@link IgnexContext} for the contract.
 */
export class IgnexContextImpl<P = Record<string, string>>
  implements IgnexContext<P, URLSearchParams>
{
  readonly req: Request;
  readonly method: HttpMethod;
  readonly route: string;
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
  private _headers: Headers | undefined;
  private _cookie: Record<string, Cookie<string | undefined>> | undefined;
  private _url: URL | undefined;
  private _path: string | undefined;
  private _query:
    | URLSearchParams
    | Record<string, string | string[]>
    | import("../../data/query").NativeQueryParams
    | undefined;
  private _requestId: string | undefined;
  private _ip: string | undefined;
  private _state: Map<string | symbol, unknown> | undefined;
  private readonly _opts: ContextOptions;

  constructor(req: Request, params: P, opts: ContextOptions = {}) {
    this.req = req;
    this.method = req.method as HttpMethod;
    this.route = opts.route ?? "";
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
    //
    // `opts.set` is undefined on the compiled path, and `{ ...undefined }` is a
    // no-op that still walks the spread machinery (`copyDataProperties`) on
    // every request — so split the literal instead of always spreading.
    this.set =
      opts.set === undefined
        ? { headers: emptyHeaders() }
        : { headers: emptyHeaders(), ...opts.set };
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

  /**
   * Request headers, materialized on FIRST access.
   *
   * `req.headers` is a lazily-built native object in Bun: reading the property
   * is what constructs it. Assigning it eagerly in the constructor made every
   * full-context request pay for that construction even when nothing ever
   * reads `ctx.headers` — and because plugins/hooks force the full context,
   * that is the COMMON production path (the specialized context literal
   * already gates the member on `usage.headers`). Lazy is free: a request that
   * never reads it never builds it.
   */
  get headers(): Headers {
    if (this._headers === undefined) this._headers = this.req.headers;
    return this._headers;
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

    this._ip = resolveClientIp(this.server, this.req, this._opts.trustProxy === true);
    return this._ip;
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
    const set = this.set;
    const status = init?.status ?? set.status ?? 200;
    const s = JSON.stringify(data);

    // Fast path: a bare `ctx.json(data)` with a default status passes
    // `undefined` straight through, so `withBody` takes its no-init branch
    // (`new Response(bytes, { headers })`) instead of allocating a
    // `{ ...rest, headers }` rest-spread object on every response.
    const response = responseWithBody(
      s === undefined ? undefined : s,
      "application/json; charset=utf-8",
      init === undefined && status === 200 ? undefined : { ...init, status },
      this._opts.responseDefaults,
      set.headers,
    );

    consumeSetHeaders(set);
    return response;
  }

  text(data: string, init?: ResponseInit): Response {
    const set = this.set;
    const status = init?.status ?? set.status ?? 200;

    const response = responseWithBody(
      String(data),
      "text/plain; charset=utf-8",
      init === undefined && status === 200 ? undefined : { ...init, status },
      this._opts.responseDefaults,
      set.headers,
    );

    consumeSetHeaders(set);
    return response;
  }

  html(data: string, init?: ResponseInit): Response {
    const set = this.set;
    const status = init?.status ?? set.status ?? 200;

    const response = responseWithBody(
      String(data),
      "text/html; charset=utf-8",
      init === undefined && status === 200 ? undefined : { ...init, status },
      this._opts.responseDefaults,
      set.headers,
    );

    consumeSetHeaders(set);
    return response;
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

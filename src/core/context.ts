/**
 * @fileoverview Flux Context v3.0 — Production-grade request context.
 * Lazy evaluation, zero-allocation fast paths, full Elysia compatibility.
 */
import * as cookie from "cookie";
import * as setCookie from "set-cookie-parser";
import type { HttpMethod, CookieOptions, ElysiaCookie } from "./types";
import { createLazyBody, type LazyBody, type LazyBodyOptions } from "./body";
import { sendFile, type SendFileOptions } from "./files";
import { proxyRequest, forwardRequest, type ProxyOptions } from "./proxy";
import { HttpResponseCache, type HttpResponseCacheOptions } from "./cache";

// ============================================================================
// Types
// ============================================================================

export interface SetHeaders {
  headers: Record<string, string>;
  status?: number;
  redirect?: string;
  cookie?: Record<string, ElysiaCookie>;
}

export interface ContextOptions {
  query?: URLSearchParams;
  body?: LazyBodyOptions;
  bodyInstance?: LazyBody;
  params?: Record<string, string>;
  set?: Partial<SetHeaders>;
}

export interface FluxContext<
  P = Record<string, string>,
  Q = URLSearchParams,
  B = unknown
> {
  readonly req: Request;
  readonly url: URL;
  readonly method: HttpMethod;
  readonly path: string;
  readonly route: string;
  readonly headers: Headers;
  readonly requestId: string;
  readonly startTime: number;

  params: P;
  readonly query: Q;
  body: LazyBody;
  cookie: Record<string, Cookie<string | undefined>>;

  state: Map<string | symbol, unknown>;

  // State accessors
  getState<T = unknown>(key: string | symbol): T | undefined;
  setState<T>(key: string | symbol, value: T): void;

  // Response helpers
  json<T>(data: T, init?: ResponseInit): Response;
  text(data: string, init?: ResponseInit): Response;
  html(data: string, init?: ResponseInit): Response;
  redirect(url: string, status?: 301 | 302 | 303 | 307 | 308): Response;
  stream(stream: ReadableStream, init?: ResponseInit): Response;
  empty(status?: number): Response;
  status(code: number): Response;

  // File & Proxy
  sendFile(path: string, opts?: SendFileOptions): Promise<Response>;
  proxy(target: string | URL, opts?: ProxyOptions): Promise<Response>;
  forward(target: string | URL, opts?: ProxyOptions): Promise<Response>;

  // Cache
  cache(factory: () => Promise<Response>, opts?: HttpResponseCacheOptions & { vary?: string[] }): Promise<Response>;

  // Server reference
  readonly server: any;
}

// ============================================================================
// Cookie Class
// ============================================================================

export class Cookie<T = string | undefined> {
  constructor(
    private name: string,
    private jar: Record<string, ElysiaCookie>,
    private initial: Partial<ElysiaCookie> = {}
  ) {}

  get value(): T { return (this.jar[this.name]?.value ?? this.initial.value) as T; }
  set value(v: T) {
    const entry = (this.jar[this.name] ??= { ...this.initial });
    entry.value = v;
  }

  get expires() { return this.jar[this.name]?.expires ?? this.initial.expires; }
  set expires(v: Date | undefined) { this._set("expires", v); }

  get maxAge() { return this.jar[this.name]?.maxAge ?? this.initial.maxAge; }
  set maxAge(v: number | undefined) { this._set("maxAge", v); }

  get domain() { return this.jar[this.name]?.domain ?? this.initial.domain; }
  set domain(v: string | undefined) { this._set("domain", v); }

  get path() { return this.jar[this.name]?.path ?? this.initial.path; }
  set path(v: string | undefined) { this._set("path", v); }

  get secure() { return this.jar[this.name]?.secure ?? this.initial.secure; }
  set secure(v: boolean | undefined) { this._set("secure", v); }

  get httpOnly() { return this.jar[this.name]?.httpOnly ?? this.initial.httpOnly; }
  set httpOnly(v: boolean | undefined) { this._set("httpOnly", v); }

  get sameSite() { return this.jar[this.name]?.sameSite ?? this.initial.sameSite; }
  set sameSite(v: true | false | "lax" | "strict" | "none" | undefined) { this._set("sameSite", v); }

  update(config: Partial<ElysiaCookie>): this {
    const entry = (this.jar[this.name] ??= { ...this.initial });
    Object.assign(entry, config);
    return this;
  }

  remove(): this {
    this.update({ expires: new Date(0), maxAge: 0, value: "" });
    return this;
  }

  toString(): string {
    const v = this.value;
    return typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
  }

  private _set(key: string, value: unknown) {
    const entry = (this.jar[this.name] ??= { ...this.initial });
    (entry as Record<string, unknown>)[key] = value;
  }
}

// ============================================================================
// Cookie Jar Factory
// ============================================================================

export const createCookieJar = (
  set: SetHeaders,
  store: Record<string, ElysiaCookie>,
  initial?: Partial<ElysiaCookie>
): Record<string, Cookie> => {
  if (!set.cookie) set.cookie = Object.create(null);
  return new Proxy(store, {
    get(_, key: string) {
      return new Cookie(key, set.cookie!, { ...initial, ...store[key] });
    }
  }) as Record<string, Cookie>;
};

// ============================================================================
// Cookie Serialization
// ============================================================================

export const serializeCookie = (
  cookies: Record<string, ElysiaCookie>
): string | string[] | undefined => {
  const entries = Object.entries(cookies).filter(([, v]) => v?.value != null);
  if (entries.length === 0) return undefined;

  const result = entries.map(([name, opts]) => {
    const value =
      typeof opts.value === "object"
        ? JSON.stringify(opts.value)
        : String(opts.value ?? "");

    const options: Record<string, unknown> = {
      domain: opts.domain,
      path: opts.path,
      expires: opts.expires,
      maxAge: opts.maxAge,
      httpOnly: opts.httpOnly,
      secure: opts.secure,
      sameSite:
        opts.sameSite === true
          ? "strict"
          : opts.sameSite === false
            ? undefined
            : opts.sameSite,
    };

    let str = cookie.serialize(name, value, options as any);

    if (opts.priority) str += `; Priority=${opts.priority}`;
    if (opts.partitioned) str += `; Partitioned`;

    return str;
  });

  return result.length === 1 ? result[0] : result;
};

// ============================================================================
// Cookie Parsing
// ============================================================================

export const parseCookieString = (
  cookieString: string | null
): Record<string, string> => {
  if (!cookieString) return {};
  return cookie.parse(cookieString);
};

export const parseSetCookieHeader = (
  header: string | string[] | null
) => {
  if (!header) return [];
  return setCookie.parse(header);
};

// ============================================================================
// Context Factory
// ============================================================================

const HDR_JSON = { "content-type": "application/json; charset=utf-8" };
const HDR_TEXT = { "content-type": "text/plain; charset=utf-8" };
const HDR_HTML = { "content-type": "text/html; charset=utf-8" };

let requestIdCounter = 0;
const generateRequestId = (): string => {
  const ts = performance.now().toString(36).replace(".", "");
  const seq = (++requestIdCounter).toString(36);
  return `${ts}-${seq}`;
};

type FluxHeadersInit =
  | Headers
  | Record<string, string>
  | [string, string][];

const mergeHeaders = (
  base: Record<string, string>,
  init?: FluxHeadersInit
): Headers => {
  const headers = new Headers(base);
  if (init) new Headers(init).forEach((v, k) => headers.set(k, v));
  return headers;
};
const defaultCache = new HttpResponseCache({ max: 1000, ttlMs: 60_000, staleTtlMs: 300_000 });

export function createContext<P = Record<string, string>>(
  req: Request,
  params: P,
  opts: ContextOptions = {}
): FluxContext<P, URLSearchParams> {
  let _url: URL | undefined;
  let _query: URLSearchParams | undefined = opts.query;

  const body = opts.bodyInstance ?? createLazyBody(req, opts.body);
  const state = new Map<string | symbol, unknown>();
  const set: SetHeaders = { headers: {}, status: 200, ...opts.set };

  const cookieStore = parseCookieString(req.headers.get("cookie"));
  const cookie = createCookieJar(set, cookieStore as any);

  const ctx: FluxContext<P, URLSearchParams> = {
    req,
    get url() { return (_url ??= new URL(req.url)); },
    method: req.method as HttpMethod,
    get path() { return this.url.pathname; },
    route: "",
    headers: req.headers,
    requestId: generateRequestId(),
    startTime: performance.now(),
    params,
    get query() { return (_query ??= this.url.searchParams) as URLSearchParams; },
    body,
    cookie,
    state,

    getState<T = unknown>(key: string | symbol): T | undefined {
      return state.get(key) as T | undefined;
    },

    setState<T>(key: string | symbol, value: T): void {
      state.set(key, value);
    },
    json<T>(data: T, init?: ResponseInit): Response {
      return Response.json(data, { status: init?.status ?? set.status ?? 200, headers: mergeHeaders(HDR_JSON, init?.headers) });
    },
    text(data: string, init?: ResponseInit): Response {
      return new Response(data, { status: init?.status ?? set.status ?? 200, headers: mergeHeaders(HDR_TEXT, init?.headers) });
    },
    html(data: string, init?: ResponseInit): Response {
      return new Response(data, { status: init?.status ?? set.status ?? 200, headers: mergeHeaders(HDR_HTML, init?.headers) });
    },
    redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
      return Response.redirect(url, status);
    },
    stream(stream: ReadableStream, init?: ResponseInit): Response {
      return new Response(stream, { status: init?.status ?? 200, headers: init?.headers });
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
      return defaultCache.getOrSet(req, factory, cacheOpts);
    },
    server: null,
  };

  return ctx;
}
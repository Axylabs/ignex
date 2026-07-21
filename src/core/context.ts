/**
 * Flux Context — Bun 1.4 edition.
 *
 * Optimizations:
 * - lazy cookie parsing
 * - lazy state map
 * - ctx.ip using Bun server.requestIP when available
 */

import * as setCookie from "set-cookie-parser";
import type { HttpMethod, CookieOptions, ElysiaCookie } from "./types";
import { createLazyBody, type LazyBody, type LazyBodyOptions } from "./body";
import { sendFile, type SendFileOptions } from "./files";
import { proxyRequest, forwardRequest, type ProxyOptions } from "./proxy";
import { HttpResponseCache, type HttpResponseCacheOptions } from "./cache";

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
  readonly ip: string;

  params: P;
  readonly query: Q;
  body: LazyBody;
  cookie: Record<string, Cookie<string | undefined>>;

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
    opts?: HttpResponseCacheOptions & { vary?: string[] }
  ): Promise<Response>;

  readonly server: any;
}

const toCookieValue = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value ?? "");

const encodeCookieValue = (value: string): string => encodeURIComponent(value);

const decodeCookieValue = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeSameSite = (
  sameSite: CookieOptions["sameSite"]
): string | undefined => {
  if (sameSite === true) return "Strict";
  if (sameSite === false || sameSite === undefined) return undefined;

  return sameSite.charAt(0).toUpperCase() + sameSite.slice(1);
};

const serializeCookiePair = (
  name: string,
  value: string,
  opts: ElysiaCookie
): string => {
  const parts = [`${name}=${encodeCookieValue(value)}`];

  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.path) parts.push(`Path=${opts.path}`);

  if (opts.expires instanceof Date) {
    parts.push(`Expires=${opts.expires.toUTCString()}`);
  }

  if (opts.maxAge != null) {
    parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  }

  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");

  const sameSite = normalizeSameSite(opts.sameSite);
  if (sameSite) parts.push(`SameSite=${sameSite}`);

  if (opts.priority) parts.push(`Priority=${opts.priority}`);
  if (opts.partitioned) parts.push("Partitioned");

  return parts.join("; ");
};

export const serializeCookie = (
  cookies: Record<string, ElysiaCookie>
): string | string[] | undefined => {
  const serialized = Object.entries(cookies)
    .filter(([, opts]) => opts?.value != null)
    .map(([name, opts]) =>
      serializeCookiePair(name, toCookieValue(opts.value), opts)
    );

  if (serialized.length === 0) return undefined;

  return serialized.length === 1 ? serialized[0] : serialized;
};

export const parseCookieString = (
  cookieString: string | null
): Record<string, string> => {
  if (!cookieString) return {};

  return cookieString
    .split(";")
    .reduce<Record<string, string>>((acc, segment) => {
      const eq = segment.indexOf("=");
      if (eq === -1) return acc;

      const key = segment.slice(0, eq).trim();
      if (!key) return acc;

      const value = segment.slice(eq + 1).trim();
      acc[key] = decodeCookieValue(value);

      return acc;
    }, {});
};

export const parseSetCookieHeader = (header: string | string[] | null) => {
  if (!header) return [];
  return setCookie.parse(header);
};

export class Cookie<T = string | undefined> {
  constructor(
    private name: string,
    private jar: Record<string, ElysiaCookie>,
    private initial: Partial<ElysiaCookie> = {}
  ) {}

  get value(): T {
    return (this.jar[this.name]?.value ?? this.initial.value) as T;
  }

  set value(v: T) {
    const entry = (this.jar[this.name] ??= { ...this.initial });
    entry.value = v;
  }

  get expires() {
    return this.jar[this.name]?.expires ?? this.initial.expires;
  }

  set expires(v: Date | undefined) {
    this._set("expires", v);
  }

  get maxAge() {
    return this.jar[this.name]?.maxAge ?? this.initial.maxAge;
  }

  set maxAge(v: number | undefined) {
    this._set("maxAge", v);
  }

  get domain() {
    return this.jar[this.name]?.domain ?? this.initial.domain;
  }

  set domain(v: string | undefined) {
    this._set("domain", v);
  }

  get path() {
    return this.jar[this.name]?.path ?? this.initial.path;
  }

  set path(v: string | undefined) {
    this._set("path", v);
  }

  get secure() {
    return this.jar[this.name]?.secure ?? this.initial.secure;
  }

  set secure(v: boolean | undefined) {
    this._set("secure", v);
  }

  get httpOnly() {
    return this.jar[this.name]?.httpOnly ?? this.initial.httpOnly;
  }

  set httpOnly(v: boolean | undefined) {
    this._set("httpOnly", v);
  }

  get sameSite() {
    return this.jar[this.name]?.sameSite ?? this.initial.sameSite;
  }

  set sameSite(v: true | false | "lax" | "strict" | "none" | undefined) {
    this._set("sameSite", v);
  }

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

export const createCookieJar = (
  set: SetHeaders,
  store: Record<string, ElysiaCookie>,
  initial?: Partial<ElysiaCookie>
): Record<string, Cookie> => {
  if (!set.cookie) set.cookie = Object.create(null);

  return new Proxy(store, {
    get(_, key: string) {
      return new Cookie(key, set.cookie!, { ...initial, ...store[key] });
    },
  }) as Record<string, Cookie>;
};

export const createLazyCookieJar = (
  set: SetHeaders,
  getCookieHeader: () => string | null,
  initial?: Partial<ElysiaCookie>
): Record<string, Cookie> => {
  if (!set.cookie) set.cookie = Object.create(null);

  let parsed: Record<string, string> | undefined;

  const ensureParsed = () => {
    if (!parsed) {
      parsed = parseCookieString(getCookieHeader());
    }

    return parsed;
  };

  const target = Object.create(null);

  return new Proxy(target, {
    get(_, key: string) {
      const store = ensureParsed();

      return new Cookie(key, set.cookie!, {
        ...initial,
        value: store[key],
      });
    },
  }) as Record<string, Cookie>;
};

const HDR_JSON = { "content-type": "application/json; charset=utf-8" };
const HDR_TEXT = { "content-type": "text/plain; charset=utf-8" };
const HDR_HTML = { "content-type": "text/html; charset=utf-8" };

let requestIdCounter = 0;

const generateRequestId = (): string => {
  const ts = performance.now().toString(36).replace(".", "");
  const seq = (++requestIdCounter).toString(36);
  return `${ts}-${seq}`;
};

type ResponseHeadersInit = NonNullable<ResponseInit["headers"]>;

type FluxHeadersInit =
  | ResponseHeadersInit
  | Record<string, string | undefined>
  | Array<[string, string | undefined]>;

const asResponseHeaders = (headers: Headers): ResponseHeadersInit =>
  headers as unknown as ResponseHeadersInit;

const mergeHeaders = (
  base: Record<string, string>,
  init?: FluxHeadersInit
): ResponseHeadersInit => {
  const headers = new Headers(base);

  if (init === undefined) {
    return asResponseHeaders(headers);
  }

  const forEachFn = (init as { forEach?: unknown }).forEach;

  if (!Array.isArray(init) && typeof forEachFn === "function") {
    (forEachFn as (cb: (value: string, key: string) => void) => void).call(
      init,
      (value, key) => {
        headers.set(key, value);
      }
    );

    return asResponseHeaders(headers);
  }

  if (Array.isArray(init)) {
    for (const [key, value] of init as Array<[string, string | undefined]>) {
      if (value !== undefined) {
        headers.set(key, value);
      }
    }

    return asResponseHeaders(headers);
  }

  for (const [key, value] of Object.entries(
    init as Record<string, string | undefined>
  )) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  return asResponseHeaders(headers);
};

const createResponseInit = (
  status: number,
  headers?: FluxHeadersInit
): ResponseInit => {
  if (headers === undefined) {
    return { status };
  }

  return {
    status,
    headers: mergeHeaders({}, headers),
  };
};

const defaultCache = new HttpResponseCache({
  max: 1000,
  ttlMs: 60_000,
  staleTtlMs: 300_000,
});

export function createContext<P = Record<string, string>>(
  req: Request,
  params: P,
  opts: ContextOptions = {}
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

  const set: SetHeaders = { headers: {}, status: 200, ...opts.set };

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

    route: "",
    headers: req.headers,
    requestId: generateRequestId(),
    startTime: performance.now(),

    get ip(): string {
      const server = (this as any).server;

      try {
        const socketIp = server?.requestIP?.(req)?.address;
        if (socketIp) return socketIp;
      } catch {
        // ignore
      }

      return req.headers.get("x-real-ip") || "anonymous";
    },

    params,

    get query() {
      return (_query ??= this.url.searchParams) as URLSearchParams;
    },

    body,
    cookie,

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
      return new Response(
        stream,
        createResponseInit(init?.status ?? 200, init?.headers)
      );
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

    redirect(
      url: string,
      status: 301 | 302 | 303 | 307 | 308 = 302
    ): Response {
      return Response.redirect(url, status);
    },

    server: null,
  };

  return ctx;
}

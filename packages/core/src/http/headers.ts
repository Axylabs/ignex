/**
 * @fileoverview HTTP response channel — `SetHeaders` accumulator and the
 * `applySet` step that applies accumulated mutations (headers, status,
 * redirect, cookies) to a final `Response`.
 *
 * `applySet` is shared by the interpreted `createApp` pipeline and the
 * compiler-generated server (`__applySet`) so both paths behave identically.
 * When nothing was mutated and no trace header is requested it returns the
 * original response unchanged (no allocation).
 */

import type { ElysiaCookie } from "../types";
import { serializeCookie } from "./cookies";

/**
 * The accumulated response mutations carried on the request context (`ctx.set`):
 * headers to apply, optional status/redirect, and cookies to write.
 */
export interface SetHeaders {
  headers: Record<string, string>;
  status?: number;
  redirect?: string;
  cookie?: Record<string, ElysiaCookie>;
}

/** Content-type header constant for JSON responses. */
export const HDR_JSON = { "content-type": "application/json; charset=utf-8" };
/** Content-type header constant for plain-text responses. */
export const HDR_TEXT = { "content-type": "text/plain; charset=utf-8" };
/** Content-type header constant for HTML responses. */
export const HDR_HTML = { "content-type": "text/html; charset=utf-8" };

type ResponseHeadersInit = NonNullable<ResponseInit["headers"]>;

type IgnusHeadersInit =
  | ResponseHeadersInit
  | Record<string, string | undefined>
  | Array<[string, string | undefined]>;

const asResponseHeaders = (headers: Headers): ResponseHeadersInit =>
  headers as unknown as ResponseHeadersInit;

/** Merge a base header record with any supported init shape (Headers / array / object). */
export const mergeHeaders = (
  base: Record<string, string>,
  init?: IgnusHeadersInit,
): ResponseHeadersInit => {
  const headers = new Headers(base);

  if (init === undefined) {
    return asResponseHeaders(headers);
  }

  const forEachFn = (init as { forEach?: unknown }).forEach;

  if (!Array.isArray(init) && typeof forEachFn === "function") {
    (forEachFn as (cb: (value: string, key: string) => void) => void).call(init, (value, key) => {
      headers.set(key, value);
    });

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

  for (const [key, value] of Object.entries(init as Record<string, string | undefined>)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  return asResponseHeaders(headers);
};

/**
 * Build a `ResponseInit` for a status with merged headers.
 *
 * Returns `{ status }` alone when no headers are given (no allocation).
 */
export const createResponseInit = (status: number, headers?: IgnusHeadersInit): ResponseInit => {
  if (headers === undefined) {
    return { status };
  }

  return {
    status,
    headers: mergeHeaders({}, headers),
  };
};

/**
 * Build a `Response` from a string body, encoding it once and setting an
 * accurate `content-length`. Bun only materializes `content-length` at serve
 * time (the in-process `Response` has it as `null`), so without this,
 * middleware (compression) must buffer a response just to learn its size when
 * the client sends `accept-encoding`. Shared by the `ctx.json/text/html`
 * builders (the interpreted `createApp` path AND compiled routes that return
 * `ctx.json(...)` directly).
 */
/**
 * Merge a supported `ResponseInit["headers"]` shape (Headers / array / object)
 * into a target Headers instance.
 */
const applyInitHeaders = (target: Headers, init: ResponseInit["headers"] | undefined): void => {
  if (!init) return;
  const isIterable =
    init instanceof Headers ||
    (typeof (init as { forEach?: unknown }).forEach === "function" && !Array.isArray(init));
  if (isIterable) {
    (init as Headers).forEach((value, key) => {
      target.set(key, value);
    });
    return;
  }
  if (Array.isArray(init)) {
    for (const [k, v] of init as Array<[string, string | undefined]>) {
      if (v !== undefined) target.set(k, v);
    }
    return;
  }
  for (const [k, v] of Object.entries(init as Record<string, string | undefined>)) {
    if (v != null) target.set(k, String(v));
  }
};

/**
 * Build a `Response` from a string body, encoding it once and setting an
 * accurate `content-length`. Bun only materializes `content-length` at serve
 * time (the in-process `Response` has it as `null`), so without this,
 * middleware (compression) must buffer a response just to learn its size when
 * the client sends `accept-encoding`. Shared by the `ctx.json/text/html`
 * builders (the interpreted `createApp` path AND compiled routes that return
 * `ctx.json(...)` directly).
 */
export const responseWithBody = (
  body: string | undefined,
  contentType: string,
  init?: ResponseInit,
): Response => {
  const headers = new Headers({ "content-type": contentType });
  applyInitHeaders(headers, init?.headers);

  const responseInit: ResponseInit = { headers };
  if (init?.status !== undefined) responseInit.status = init.status;
  if (init?.statusText !== undefined) responseInit.statusText = init.statusText;

  if (body !== undefined) {
    const bytes = new TextEncoder().encode(body);
    headers.set("content-length", String(bytes.byteLength));
    return new Response(bytes, responseInit);
  }
  return new Response(null, responseInit);
};

/**
 * Hop-by-hop headers that must never be forwarded or cached — single source
 * of truth shared by `http/proxy` and `data/cache`.
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

/**
 * Return a new `Headers` with hop-by-hop headers removed (they must never be
 * forwarded or cached). Single source of truth for hop-by-hop sanitizing —
 * shared by `http/proxy` and `data/cache`.
 */
export const stripHopByHopHeaders = (headers: Headers): Headers => {
  const out = new Headers(headers);
  for (const h of HOP_BY_HOP_HEADERS) out.delete(h);
  return out;
};

/** Append a `Vary` value de-duplicated against the existing header (case-insensitive). */
export const appendVary = (headers: Headers, value: string): void => {
  const existing = headers.get("vary");

  if (!existing) {
    headers.set("vary", value);
    return;
  }

  const parts = existing.split(",").map((x) => x.trim().toLowerCase());

  if (!parts.includes(value.toLowerCase())) {
    headers.set("vary", `${existing}, ${value}`);
  }
};

/** Rebuild a `Response` around the same body with optional status/headers overrides. */
export const reWrapResponse = (
  response: Response,
  init: { status?: number; statusText?: string; headers?: HeadersInit } = {},
): Response =>
  new Response(response.body, {
    status: init.status ?? response.status,
    statusText: init.statusText ?? response.statusText,
    headers: init.headers ?? response.headers,
  });

/**
 * Apply header mutations to a response without re-wrapping when possible.
 *
 * Bun allows in-place mutation of a `Response`'s headers (even fetched/
 * proxied ones) and reflects it on the wire (probed 2026-08-13). In-place
 * mutation avoids a `new Headers(response.headers)` copy + `new
 * Response(response.body, ...)` re-wrap — the dominant per-request JS cost in
 * the plugin chain (security re-wrap alone ~2.5-4µs) — and, crucially, keeps
 * `content-length` + the original body stream intact across the chain.
 *
 * Falls back to the copy + re-wrap when the response's headers are immutable
 * (e.g. a non-Bun runtime that enforces the Fetch spec).
 *
 * `mutate` MUST only touch headers (set/append/delete) — its result is
 * discarded and re-applied on the copied headers in the fallback path.
 */
export const mutateHeaders = (response: Response, mutate: (headers: Headers) => void): Response => {
  try {
    mutate(response.headers);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    mutate(headers);
    return reWrapResponse(response, { headers });
  }
};

/** Set (or append, for array values) a single header value on a Headers. */
const applyHeaderValue = (h: Headers, key: string, value: string | string[]): void => {
  if (Array.isArray(value)) {
    h.delete(key);
    for (const x of value) h.append(key, String(x));
  } else {
    h.set(key, String(value));
  }
};

/** Serialize and append a cookie record's `Set-Cookie` values. */
const applySetCookies = (h: Headers, cookie: Record<string, ElysiaCookie> | undefined): void => {
  if (!cookie || typeof cookie !== "object") return;
  const s = serializeCookie(cookie);
  if (s) {
    if (Array.isArray(s)) for (const c of s) h.append("set-cookie", c);
    else h.append("set-cookie", s);
  }
};

/**
 * Apply accumulated header + cookie mutations to a `Headers` instance.
 *
 * Single shared implementation for the in-place `mutateHeaders` path and the
 * copy + re-wrap fallback, so both apply identical mutations.
 */
const applySetHeaders = (
  h: Headers,
  headers: Record<string, string> | undefined,
  cookie: Record<string, ElysiaCookie> | undefined,
  trace: boolean,
  requestId?: string,
): void => {
  if (trace && requestId) h.set("x-request-id", requestId);

  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      applyHeaderValue(h, k, v);
    }
  }

  applySetCookies(h, cookie);
};

/**
 * Apply a request's accumulated `set` mutations to a final `Response`.
 */
export const applySet = (
  response: Response,
  set: SetHeaders | undefined,
  requestId?: string,
  trace = false,
): Response => {
  if (!set) return response;

  const { headers, cookie, status, redirect } = set;

  // Fast path: nothing was mutated and no trace header requested.
  if (
    !trace &&
    status === undefined &&
    redirect === undefined &&
    (headers === undefined || Object.keys(headers).length === 0) &&
    (cookie === undefined || Object.keys(cookie).length === 0)
  ) {
    return response;
  }

  if (redirect !== undefined) {
    return Response.redirect(redirect, status ?? 302);
  }

  // Header/cookie-only mutations (no status change): mutate the response's
  // headers IN PLACE when possible (Bun) instead of re-wrapping — preserves the
  // body stream and content-length and avoids a new Response per request.
  if (status === undefined) {
    return mutateHeaders(response, (h) => applySetHeaders(h, headers, cookie, trace, requestId));
  }

  const h = new Headers(response.headers);
  applySetHeaders(h, headers, cookie, trace, requestId);
  return reWrapResponse(response, { status: status ?? response.status, headers: h });
};

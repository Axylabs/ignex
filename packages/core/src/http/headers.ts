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

export interface SetHeaders {
  headers: Record<string, string>;
  status?: number;
  redirect?: string;
  cookie?: Record<string, ElysiaCookie>;
}

export const HDR_JSON = { "content-type": "application/json; charset=utf-8" };
export const HDR_TEXT = { "content-type": "text/plain; charset=utf-8" };
export const HDR_HTML = { "content-type": "text/html; charset=utf-8" };

type ResponseHeadersInit = NonNullable<ResponseInit["headers"]>;

type FluxHeadersInit =
  | ResponseHeadersInit
  | Record<string, string | undefined>
  | Array<[string, string | undefined]>;

const asResponseHeaders = (headers: Headers): ResponseHeadersInit =>
  headers as unknown as ResponseHeadersInit;

/** Merge a base header record with any supported init shape (Headers / array / object). */
export const mergeHeaders = (
  base: Record<string, string>,
  init?: FluxHeadersInit,
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

export const createResponseInit = (status: number, headers?: FluxHeadersInit): ResponseInit => {
  if (headers === undefined) {
    return { status };
  }

  return {
    status,
    headers: mergeHeaders({}, headers),
  };
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

  const h = new Headers(response.headers);
  if (trace && requestId) h.set("x-request-id", requestId);

  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        h.delete(k);
        for (const x of v) h.append(k, String(x));
      } else {
        h.set(k, String(v));
      }
    }
  }

  if (cookie && typeof cookie === "object") {
    const s = serializeCookie(cookie);
    if (s) {
      if (Array.isArray(s)) for (const c of s) h.append("set-cookie", c);
      else h.append("set-cookie", s);
    }
  }

  return reWrapResponse(response, { status: status ?? response.status, headers: h });
};

/**
 * HTTP parsing & negotiation primitives (native-accelerated where proven):
 * query-string / cookie parsing, media-type parsing & wildcard matching,
 * ETag generation, multipart parsing, and Accept-Encoding negotiation.
 *
 * The pure-TS fallbacks are byte/behavior compatible for the common cases so
 * the framework behaves identically with or without the Rust addon.
 */

import { pairsToObject } from "./packed";
import { nativeFor } from "./runtime";
import { crc32, fromBytes, toBytes } from "./util";

export type Pairs = ReadonlyArray<[string, string]>;

export interface MediaTypeResult {
  /** Lowercased `type/subtype`. */
  mediaType: string;
  charset?: string;
  boundary?: string;
  params: Record<string, string>;
}

export interface EncodingPrefResult {
  encoding: string;
  q: number;
  order: number;
}

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
}

export interface MultipartLimits {
  maxParts?: number;
  maxFieldCount?: number;
  maxPartBytes?: number;
  maxTotalBytes?: number;
}

// ── Query strings ───────────────────────────────────────────────

/** Parse a query string into `[name, value]` pairs (duplicates preserved). */
export const queryPairs = (input: string | Uint8Array): Pairs => {
  // Selection: js (native x0.96) — see selection.ts.
  return queryPairsFallback(toBytes(input));
};

export const queryPairsFallback = (input: Uint8Array): Pairs => {
  const out: Array<[string, string]> = [];
  const text = fromBytes(input);
  if (!text) return out;
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    out.push([decode(name), decode(value)]);
  }
  return out;
};

/** Parse a query string into an object (last value wins per key). */
export const parseQuery = (input: string | Uint8Array): Record<string, string> =>
  pairsToObject(queryPairs(input));

// ── Cookies ─────────────────────────────────────────────────────

/** Parse a `Cookie` header into `[name, value]` pairs. */
export const cookiePairs = (input: string | Uint8Array): Pairs => {
  // Selection: js (native x0.65) — see selection.ts.
  return cookiePairsFallback(toBytes(input));
};

export const cookiePairsFallback = (input: Uint8Array): Pairs => {
  const out: Array<[string, string]> = [];
  const text = fromBytes(input);
  if (!text) return out;
  const unquote = (s: string): string =>
    s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    const value = eq < 0 ? "" : unquote(part.slice(eq + 1).trim());
    if (name) out.push([name, value]);
  }
  return out;
};

/** Parse a `Cookie` header into an object (last value wins per key). */
export const parseCookie = (input: string | Uint8Array): Record<string, string> =>
  pairsToObject(cookiePairs(input));

// ── Media types ─────────────────────────────────────────────────

export const parseMediaType = (input: string): MediaTypeResult =>
  // Selection: js (native marked @deprecated / slower) — see selection.ts.
  parseMediaTypeFallback(input);

export const parseMediaTypeFallback = (input: string): MediaTypeResult => {
  const idx = input.indexOf(";");
  const mediaType = (idx < 0 ? input : input.slice(0, idx)).trim().toLowerCase();
  const params: Record<string, string> = {};
  if (idx >= 0) {
    for (const seg of input.slice(idx + 1).split(";")) {
      const eq = seg.indexOf("=");
      if (eq < 0) continue;
      const k = seg.slice(0, eq).trim().toLowerCase();
      const v = seg
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "");
      params[k] = v;
    }
  }
  const result: MediaTypeResult = { mediaType, params };
  if (params.charset) result.charset = params.charset;
  if (params.boundary) result.boundary = params.boundary;
  return result;
};

/** Wildcard media-type match: `"*"` (any), `"type/*"`, or exact `"type/subtype"`. */
export const mediaTypeMatches = (actual: string, expected: string): boolean => {
  const a = actual.toLowerCase().trim().split(";")[0] ?? "";
  const e = expected.toLowerCase().trim();
  if (e === "*/*") return true;
  if (e.endsWith("/*")) return a.startsWith(e.slice(0, -1));
  return a === e;
};

// ── ETag ────────────────────────────────────────────────────────

/** Generate a strong (`"<8-hex>"`) or weak (`W/"<8-hex>"`) ETag from a crc32. */
export const etag = (input: string | Uint8Array, weak = false): string => {
  // Selection: js (native x0.92) — see selection.ts.
  return etagFallback(toBytes(input), weak);
};

export const etagFallback = (input: Uint8Array, weak: boolean): string => {
  const hex = (crc32(input) >>> 0).toString(16).padStart(8, "0");
  return weak ? `W/"${hex}"` : `"${hex}"`;
};

// ── Accept-Encoding ─────────────────────────────────────────────

/** Parse an `Accept-Encoding` header into ordered `{encoding, q}` entries. */
export const parseAcceptEncoding = (input: string): EncodingPrefResult[] =>
  parseAcceptEncodingFallback(input);

export const parseAcceptEncodingFallback = (input: string): EncodingPrefResult[] => {
  const out: EncodingPrefResult[] = [];
  if (!input) return out;
  let order = 0;
  for (const item of input.split(",")) {
    const [name, ...params] = item.trim().split(";");
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const eq = p.indexOf("=");
      if (eq >= 0 && p.slice(0, eq).trim() === "q") {
        const parsed = Number(p.slice(eq + 1).trim());
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    out.push({ encoding: name.trim().toLowerCase(), q, order: order++ });
  }
  return out;
};

// ── Form (application/x-www-form-urlencoded) ────────────────────

/** Parse a `x-www-form-urlencoded` body into `[name, value]` pairs. */
export const formPairs = (input: string | Uint8Array): Pairs => {
  // Selection: js (native x0.88) — see selection.ts.
  return formPairsFallback(toBytes(input));
};

export const formPairsFallback = (input: Uint8Array): Pairs => {
  const out: Array<[string, string]> = [];
  const text = fromBytes(input);
  if (!text) return out;
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    out.push([decode(name), decode(value)]);
  }
  return out;
};

/** Parse a `x-www-form-urlencoded` body into an object (last value wins). */
export const parseForm = (input: string | Uint8Array): Record<string, string> =>
  pairsToObject(formPairs(input));

// ── Conditional requests (ETag / Last-Modified → 304) ───────────

export interface ConditionalRequest {
  /** `true` → "304 Not Modified" (If-None-Match wins over If-Modified-Since). */
  isNotModified(ifNoneMatch?: string | null, ifModifiedSince?: string | null): boolean;
}

/**
 * Compile a per-resource conditional-check instance (etag + last-modified
 * computed once, then reused across requests). Native-backed when available;
 * the fallback mirrors castrum's `ConditionalRequest` semantics exactly
 * (RFC 7232 §3.2 — weak opaque-tag comparison, `*` short-circuit, and
 * If-None-Match precedence over If-Modified-Since).
 */
export const createConditionalRequest = (
  etagValue: string,
  lastModifiedSecs?: number,
): ConditionalRequest =>
  // Selection: js — per-call native construction loses (~12x) — see selection.ts.
  createConditionalRequestFallback(etagValue, lastModifiedSecs);

export const createConditionalRequestFallback = (
  etagValue: string,
  lastModifiedSecs?: number,
): ConditionalRequest => {
  const strong = etagValue.trim().replace(/^W\//, "");
  const weakEq = (tag: string): boolean => tag.trim().replace(/^W\//, "") === strong;
  const lastModified = Math.max(0, Math.floor(lastModifiedSecs ?? 0));
  return {
    isNotModified(ifNoneMatch, ifModifiedSince) {
      if (ifNoneMatch) {
        const header = ifNoneMatch.trim();
        if (header === "*") return true;
        return header.split(",").some((candidate) => weakEq(candidate));
      }
      if (lastModified > 0 && ifModifiedSince) {
        const secs = Date.parse(ifModifiedSince);
        if (!Number.isNaN(secs)) return lastModified <= Math.floor(secs / 1000);
      }
      return false;
    },
  };
};

// ── Accept negotiation (Accept-Encoding / Accept-Language) ──────

export interface AcceptNegotiator {
  /** Best supported value for `header`, or `null` when nothing matches. */
  negotiate(header: string | null): string | null;
}

/**
 * Compile a supported-value list once and negotiate headers against it.
 * Mirrors castrum's `AcceptNegotiator` (RFC 7231 §5.3.4): specificity first
 * (exact > `*`), then q-value, then earliest client order.
 */
export const createAcceptNegotiator = (supported: string[]): AcceptNegotiator =>
  // Selection: js (parity) — see selection.ts.
  createAcceptNegotiatorFallback(supported);

export const createAcceptNegotiatorFallback = (supported: string[]): AcceptNegotiator => {
  const normalized = supported.map((s) => s.toLowerCase());
  return {
    negotiate(header) {
      const prefs = parseAcceptEncodingFallback(header ?? "");
      if (prefs.length === 0) return normalized[0] ?? null;
      let best: { enc: string; q: number; spec: number; order: number } | null = null;
      for (const sup of normalized) {
        let matched: { q: number; spec: number; order: number } | null = null;
        for (const pref of prefs) {
          const spec = pref.encoding === sup ? 2 : pref.encoding === "*" ? 1 : -1;
          if (spec < 0) continue;
          if (
            matched === null ||
            spec > matched.spec ||
            (spec === matched.spec && pref.order < matched.order)
          ) {
            matched = { q: pref.q, spec, order: pref.order };
          }
        }
        if (matched === null || matched.q <= 0) continue;
        const cand = { enc: sup, q: matched.q, spec: matched.spec, order: matched.order };
        if (
          best === null ||
          cand.spec > best.spec ||
          (cand.spec === best.spec && Math.abs(cand.q - best.q) > 1e-4 && cand.q > best.q) ||
          (cand.spec === best.spec && Math.abs(cand.q - best.q) <= 1e-4 && cand.order < best.order)
        ) {
          best = cand;
        }
      }
      return best ? best.enc : null;
    },
  };
};

// ── Multipart ───────────────────────────────────────────────────

/** Parse a `multipart/form-data` body bounded by DoS limits. */
export const multipartParse = (
  body: Uint8Array,
  boundary: string,
  limits?: MultipartLimits,
): MultipartPart[] => {
  const n = nativeFor("multipartParse");
  if (n) return n.multipartParse(body, toBytes(boundary), limits ?? null);
  return multipartParseFallback(body, boundary, limits);
};

const CR = 0x0d;
const LF = 0x0a;
const HYPHEN = 0x2d;

/** Find the first occurrence of `needle` in `haystack` at/after `from`. */
const indexOf = (haystack: Uint8Array, needle: Uint8Array, from: number): number => {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

/** Find the end of the header block (`\r\n\r\n` or `\n\n`). */
const findHeaderEnd = (body: Uint8Array, from: number): number => {
  for (let i = from; i < body.length - 1; i++) {
    if (body[i] === LF && body[i + 1] === LF) return i + 2;
    if (body[i] === CR && body[i + 1] === LF && body[i + 2] === CR && body[i + 3] === LF) {
      return i + 4;
    }
  }
  return body.length;
};

const parseHeaders = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return out;
};

/** Hand-rolled multipart parser (mirrors the native memchr-based parser's limits). */
export const multipartParseFallback = (
  body: Uint8Array,
  boundary: string,
  limits?: MultipartLimits,
): MultipartPart[] => {
  const parts: MultipartPart[] = [];
  const maxParts = limits?.maxParts ?? 1000;
  const maxFieldCount = limits?.maxFieldCount ?? 1000;
  const maxPartBytes = limits?.maxPartBytes ?? 10 * 1024 * 1024;
  const maxTotalBytes = limits?.maxTotalBytes ?? 64 * 1024 * 1024;

  const delim = toBytes(`--${boundary}`);
  let total = 0;
  let fieldCount = 0;
  let start = indexOf(body, delim, 0);
  if (start < 0) return parts;

  while (start >= 0) {
    let pos = start + delim.length;
    // Closing delimiter `--`.
    if (body[pos] === HYPHEN && body[pos + 1] === HYPHEN) break;
    // Skip the CRLF (or bare LF) after the boundary line.
    if (body[pos] === CR) pos++;
    if (body[pos] === LF) pos++;

    const headerEnd = findHeaderEnd(body, pos);
    const headers = parseHeaders(fromBytes(body.subarray(pos, headerEnd)));
    pos = headerEnd;

    const nextStart = indexOf(body, delim, pos);
    if (nextStart < 0) break;

    let contentEnd = nextStart;
    if (body[contentEnd - 1] === LF) contentEnd--;
    if (body[contentEnd - 1] === CR) contentEnd--;
    const data = body.slice(pos, contentEnd);

    const disposition = headers["content-disposition"] ?? "";
    const nameMatch = /(?:^|;)\s*name="([^"]*)"/.exec(disposition);
    const filenameMatch = /(?:^|;)\s*filename="([^"]*)"/.exec(disposition);

    if (nameMatch) {
      if (!headers["content-type"] && !filenameMatch) fieldCount++;
      const part: MultipartPart = { name: nameMatch[1]!, data };
      if (filenameMatch) part.filename = filenameMatch[1]!;
      if (headers["content-type"]) part.contentType = headers["content-type"];
      parts.push(part);
      total += data.length;
    }

    if (
      parts.length > maxParts ||
      fieldCount > maxFieldCount ||
      data.length > maxPartBytes ||
      total > maxTotalBytes
    ) {
      break;
    }

    start = nextStart;
  }

  return parts;
};

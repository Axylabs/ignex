/**
 * HTTP parsing & negotiation primitives (native-accelerated where proven):
 * query-string / cookie parsing, media-type parsing & wildcard matching,
 * ETag generation, multipart parsing, and Accept-Encoding negotiation.
 *
 * The pure-TS fallbacks are byte/behavior compatible for the common cases so
 * the framework behaves identically with or without the Rust addon.
 */
import { getNative } from "./loader";
import { pairsToObject, readPairsPacked } from "./packed";
import { crc32, fromBytes, toBytes } from "./util";

const native = getNative();

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
  const bytes = toBytes(input);
  if (native) return readPairsPacked(native.queryParsePacked(bytes));
  return queryPairsFallback(bytes);
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
  const bytes = toBytes(input);
  if (native) return readPairsPacked(native.cookieParsePacked(bytes));
  return cookiePairsFallback(bytes);
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

export const parseMediaType = (input: string): MediaTypeResult => {
  if (native) return native.parseMediaType(toBytes(input));
  return parseMediaTypeFallback(input);
};

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
  if (native) return fromBytes(native.etag(toBytes(input), weak));
  return etagFallback(toBytes(input), weak);
};

export const etagFallback = (input: Uint8Array, weak: boolean): string => {
  const hex = (crc32(input) >>> 0).toString(16).padStart(8, "0");
  return weak ? `W/"${hex}"` : `"${hex}"`;
};

// ── Accept-Encoding ─────────────────────────────────────────────

/** Parse an `Accept-Encoding` header into ordered `{encoding, q}` entries. */
export const parseAcceptEncoding = (input: string): EncodingPrefResult[] => {
  if (native) return native.parseAcceptEncoding(toBytes(input));
  return parseAcceptEncodingFallback(input);
};

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

// ── Multipart ───────────────────────────────────────────────────

/** Parse a `multipart/form-data` body bounded by DoS limits. */
export const multipartParse = (
  body: Uint8Array,
  boundary: string,
  limits?: MultipartLimits,
): MultipartPart[] => {
  if (native) return native.multipartParse(body, toBytes(boundary), limits ?? null);
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

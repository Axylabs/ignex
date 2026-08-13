/**
 * @fileoverview Multipart `multipart/form-data` parsing bounded by DoS limits.
 */

import { nativeFor } from "../runtime";
import { fromBytes, toBytes } from "../util";
import type { MultipartLimits, MultipartPart } from "./types";

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

interface ParseState {
  parts: MultipartPart[];
  total: number;
  fieldCount: number;
}

interface ParsedPart {
  nextStart: number;
  partBytes: number;
}

/** Parse one multipart part starting just past the boundary delimiter. */
const parseOnePart = (
  body: Uint8Array,
  delim: Uint8Array,
  pos: number,
  state: ParseState,
): ParsedPart => {
  let p = pos;
  // Skip the CRLF (or bare LF) after the boundary line.
  if (body[p] === CR) p++;
  if (body[p] === LF) p++;

  const headerEnd = findHeaderEnd(body, p);
  const headers = parseHeaders(fromBytes(body.subarray(p, headerEnd)));
  p = headerEnd;

  const nextStart = indexOf(body, delim, p);
  if (nextStart < 0) return { nextStart: -1, partBytes: 0 };

  let contentEnd = nextStart;
  if (body[contentEnd - 1] === LF) contentEnd--;
  if (body[contentEnd - 1] === CR) contentEnd--;
  const data = body.slice(p, contentEnd);

  const disposition = headers["content-disposition"] ?? "";
  const nameMatch = /(?:^|;)\s*name="([^"]*)"/.exec(disposition);
  const filenameMatch = /(?:^|;)\s*filename="([^"]*)"/.exec(disposition);

  if (nameMatch) {
    if (!headers["content-type"] && !filenameMatch) state.fieldCount++;
    const part: MultipartPart = { name: nameMatch[1] ?? "", data };
    if (filenameMatch) part.filename = filenameMatch[1] ?? "";
    if (headers["content-type"]) part.contentType = headers["content-type"];
    state.parts.push(part);
    state.total += data.length;
  }

  return { nextStart, partBytes: data.length };
};

/** Hand-rolled multipart parser (mirrors the native memchr-based parser's limits). */
export const multipartParseFallback = (
  body: Uint8Array,
  boundary: string,
  limits?: MultipartLimits,
): MultipartPart[] => {
  const maxParts = limits?.maxParts ?? 1000;
  const maxFieldCount = limits?.maxFieldCount ?? 1000;
  const maxPartBytes = limits?.maxPartBytes ?? 10 * 1024 * 1024;
  const maxTotalBytes = limits?.maxTotalBytes ?? 64 * 1024 * 1024;

  const delim = toBytes(`--${boundary}`);
  const state: ParseState = { parts: [], total: 0, fieldCount: 0 };
  let start = indexOf(body, delim, 0);
  if (start < 0) return state.parts;

  while (start >= 0) {
    const pos = start + delim.length;
    // Closing delimiter `--`.
    if (body[pos] === HYPHEN && body[pos + 1] === HYPHEN) break;

    const parsed = parseOnePart(body, delim, pos, state);
    if (parsed.nextStart < 0) break;
    if (
      state.parts.length > maxParts ||
      state.fieldCount > maxFieldCount ||
      parsed.partBytes > maxPartBytes ||
      state.total > maxTotalBytes
    ) {
      break;
    }
    start = parsed.nextStart;
  }

  return state.parts;
};

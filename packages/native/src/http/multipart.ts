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

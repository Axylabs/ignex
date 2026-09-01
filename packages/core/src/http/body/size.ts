/**
 * @fileoverview Body size enforcement — content-length pre-check + post-parse
 * guard. Pure functions, no request state.
 */

import { BodyParseError } from "./errors";
import { forEachFormDataEntry, isFile } from "./form-data";
import type { BodyKind } from "./types";

/** Byte length of a string in UTF-8.
 *
 * `Buffer.byteLength` computes the length natively WITHOUT materializing the
 * encoded `Uint8Array` — this runs on every request whose body is size-checked,
 * so the old `new TextEncoder().encode(...)` allocation was pure waste. */
export const textByteLength = (text: string): number => Buffer.byteLength(text ?? "");

/**
 * Throw 413 when the request's `content-length` already exceeds the limit.
 * This pre-check is bypassed by chunked transfer encoding, so the post-parse
 * guard in `assertParsedSize` closes that hole.
 */
export function assertContentLength(req: Request, max?: number): void {
  if (!max) return;

  const len = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(len) && len > max) {
    throw new BodyParseError("Payload too large", 413);
  }
}

/**
 * Read the request body under a hard byte cap — the streaming counterpart to
 * `assertContentLength` + `assertParsedSize` for callers that need the RAW
 * bytes up front (the compiled per-route native prelude).
 *
 * Order of defense:
 *  1. `content-length` pre-check (no read at all when already over);
 *  2. incremental stream read that aborts with 413 the moment the running
 *     total exceeds `max` — closing the chunked-transfer hole that an
 *     unconditional `req.arrayBuffer()` leaves open (an adversarial chunked
 *     request could otherwise buffer up to Bun.serve's `maxRequestBodySize`
 *     per in-flight request on routes whose real limit is far smaller).
 *
 * Throws {@link BodyParseError} with status 413 — identical to the lazy-body
 * guards, so the framework error pipeline produces the same response shape.
 * When `max` is unset the body is read unbounded (caller opted out).
 */
export async function readBodyBounded(req: Request, max?: number): Promise<Uint8Array> {
  assertContentLength(req, max);

  const stream = req.body;
  if (!stream) return new Uint8Array(0);

  if (!max) return new Uint8Array(await req.arrayBuffer());

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        over = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    // Release (and drain-cancel) so an aborted read never leaves a locked
    // stream — the server tears the request down right after the 413.
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
    reader.releaseLock();
  }
  if (over) throw new BodyParseError("Payload too large", 413);

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

/** Measure the parsed value's byte size for the given kind. */
export function measureParsedSize(kind: BodyKind, parsed: unknown): number {
  switch (kind) {
    case "text":
      return textByteLength(parsed as string);
    case "json":
      return textByteLength(JSON.stringify(parsed) ?? "");
    case "arrayBuffer":
      return (parsed as ArrayBuffer).byteLength;
    case "blob":
      return (parsed as Blob).size;
    case "formData": {
      let size = 0;
      forEachFormDataEntry(parsed as FormData, (value) => {
        if (typeof value === "string") size += textByteLength(value);
        else if (isFile(value)) size += value.size;
      });
      return size;
    }
    default:
      return 0;
  }
}

/**
 * Enforce size limits on the parsed value. The `content-length` pre-check in
 * `assertContentLength` is bypassed by chunked transfer encoding (no
 * content-length header), so an unbounded `req.text()/json()/formData()`
 * would otherwise buffer arbitrarily large payloads. This post-parse guard
 * closes that hole.
 *
 * For `json`, `rawBytes` (the raw wire-byte length captured at parse time)
 * takes precedence over re-serializing the parsed value — measuring the wire
 * bytes is free AND is the correct size to guard (consistent with the
 * content-length pre-check).
 */
export function assertParsedSize(
  target: BodyKind,
  parsed: unknown,
  max?: number,
  rawBytes?: number,
): void {
  if (!max) return;

  const size =
    target === "json" && rawBytes && rawBytes > 0 ? rawBytes : measureParsedSize(target, parsed);

  if (size > max) {
    throw new BodyParseError("Payload too large", 413);
  }
}

/**
 * @fileoverview Body size enforcement — content-length pre-check + post-parse
 * guard. Pure functions, no request state.
 */

import { BodyParseError } from "./errors";
import { forEachFormDataEntry, isFile } from "./form-data";
import type { BodyKind } from "./types";

/** Byte length of a string in UTF-8. */
export const textByteLength = (text: string): number =>
  new TextEncoder().encode(text ?? "").byteLength;

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
 */
export function assertParsedSize(target: BodyKind, parsed: unknown, max?: number): void {
  if (!max) return;

  if (measureParsedSize(target, parsed) > max) {
    throw new BodyParseError("Payload too large", 413);
  }
}

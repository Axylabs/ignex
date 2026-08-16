/**
 * @fileoverview Cache keys and ETags — fast hashing over body bytes.
 */

import { fnv1a64 } from "@ignex/native";
import { encoder } from "../../http/encoder";

const toBytes = (input: string | ArrayBuffer | Uint8Array): Uint8Array => {
  if (typeof input === "string") return encoder.encode(input);
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
};

/**
 * Fast non-cryptographic hash for cache keys and weak ETags.
 * Delegates to `@ignex/native` `fnv1a64` — the selection table
 * (`packages/native/src/selection.ts`) owns the impl choice (castrum native,
 * measured x6.74 on the 2026-08-11 bench) with a deterministic pure-TS
 * fallback — so results are identical whether or not the addon is present.
 */
export function fastHash(input: string | ArrayBuffer | Uint8Array): string {
  return fnv1a64(toBytes(input)).toString(36);
}

/**
 * Compute a strong/weak ETag for a body.
 *
 * Uses {@link fastHash} (fnv1a64) — non-cryptographic but collision-resistant
 * enough for ETag/cache purposes.
 *
 * @param body - The response body to tag.
 * @param weak - Emit a `W/` weak ETag (default `true`).
 * @returns The `ETag` header value.
 */
export function entityTag(body: string | ArrayBuffer | Uint8Array, weak = true): string {
  return `${weak ? "W/" : ""}"${fastHash(body)}"`;
}

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
 * `Bun.hash.wyhash` — a C++ 64-bit hash that beats `fnv1a64` by ~16x for
 * runtime-local keys (see `docs/bun-internals.md`). Detected once at load;
 * falls back to the `@ignex/native` `fnv1a64` (castrum native or pure-TS)
 * when not running under Bun.
 */
const bunWyhash = (
  globalThis as unknown as {
    Bun?: { hash?: { wyhash(input: Uint8Array, seed?: number): bigint } };
  }
).Bun?.hash?.wyhash;

/**
 * Fast non-cryptographic hash for cache keys and weak ETags.
 *
 * Under Bun this uses `Bun.hash.wyhash` (runtime-local keys/ETags only — not
 * used for the compiler's on-disk incremental cache, which stays on `fnv1a64`
 * for cross-runtime key stability). Otherwise it delegates to `@ignex/native`
 * `fnv1a64`, whose selection table owns the impl choice (castrum native, with
 * a deterministic pure-TS fallback).
 */
export function fastHash(input: string | ArrayBuffer | Uint8Array): string {
  const bytes = toBytes(input);
  if (bunWyhash) return bunWyhash(bytes).toString(36);
  return fnv1a64(bytes).toString(36);
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

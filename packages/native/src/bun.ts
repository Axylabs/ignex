/**
 * Bun's native built-ins, feature-detected once at module load.
 *
 * castrum is Bun-first; for several ops Bun's native built-in is FASTER than
 * both the Rust addon and a pure-TS fallback (measured in castrum's
 * `docs/bun-builtins-decision-matrix.md` — e.g. `Bun.gzipSync` ~2.0x,
 * `Bun.hash.crc32` 2.8–8.4x, `Bun.CryptoHasher` ~1.2x). Wrappers prefer these
 * under Bun so they never ship something slower than what Bun natively
 * provides. Each export is `null` when not running under Bun (or the API is
 * absent), resolved ONCE at load — there is no per-call feature check.
 */

import { encoder, hexEncode } from "./util";

const g = globalThis as { Bun?: Record<string, unknown> };
const B = g.Bun;

type GzipFn = (data: Uint8Array, level?: number) => Uint8Array;
type HmacFn = (key: Uint8Array, data: Uint8Array) => Uint8Array;

const isFn = (v: unknown): v is (...args: unknown[]) => unknown => typeof v === "function";

/** Whether the host runtime is Bun (mirrors castrum's `isBun`). */
export const isBunRuntime = (): boolean => typeof B !== "undefined";

const gzipRaw = B?.gzipSync as
  | ((data: Uint8Array, options?: { level?: number }) => Uint8Array)
  | undefined;
/**
 * `Bun.gzipSync` when available (~2.0x faster than the Rust addon at 11KB).
 * Bun's API takes an options OBJECT (e.g. `{ level }`), so we adapt the
 * `(data, level)` call shape.
 */
export const bunGzipSync: GzipFn | null =
  gzipRaw === undefined
    ? null
    : (data: Uint8Array, level?: number) => gzipRaw(data, level === undefined ? {} : { level });

const gunzipRaw = B?.gunzipSync as ((data: Uint8Array) => Uint8Array) | undefined;
/** `Bun.gunzipSync` when available (~1.4x faster than the Rust addon). */
export const bunGunzipSync: GzipFn | null = isFn(gunzipRaw) ? (gunzipRaw as GzipFn) : null;

const hashObj = B?.hash as Record<string, unknown> | undefined;
const crc32Raw = hashObj?.crc32;
/** `Bun.hash.crc32` when available (2.8–8.4x faster than the Rust addon). */
export const bunCrc32: ((data: Uint8Array) => number) | null = isFn(crc32Raw)
  ? (crc32Raw as (data: Uint8Array) => number)
  : null;

const CryptoHasher = B?.CryptoHasher as
  | (new (
      algo: string,
      key?: Uint8Array,
    ) => {
      update(data: Uint8Array): void;
      digest(): Uint8Array;
      digest(encoding: string): string;
    })
  | undefined;
/** HMAC-SHA256 via `Bun.CryptoHasher` when available (~1.2x faster than Rust). */
export const bunHmacSha256: HmacFn | null =
  CryptoHasher === undefined
    ? null
    : (key: Uint8Array, data: Uint8Array) => {
        const h = new CryptoHasher("sha256", key);
        h.update(data);
        // Match the native addon's LOCKED format: `Bun.CryptoHasher.digest()`
        // returns the raw 32 bytes, but native `hmacSha256` returns a 64-hex
        // string and `hmacSha256Verify` expects hex — so hex-encode here to
        // keep sign→verify byte-compatible across backends (the castrum
        // delegation does the same "hex re-encoded" step).
        return encoder.encode(hexEncode(h.digest()));
      };

/**
 * SHA-1 → standard base64 (RFC 6455 `Sec-WebSocket-Accept`) via
 * `Bun.CryptoHasher` when available (~1.1–1.25x faster than `node:crypto`
 * `createHash("sha1")` — see `docs/bun-internals.md`). The digest is returned
 * in the same standard-base64 form the pure-TS `wsAcceptKey` fallback
 * produces, so the websocket handshake stays byte-identical across backends.
 */
export const bunSha1Base64: ((input: string) => string) | null =
  CryptoHasher === undefined
    ? null
    : (input: string) => {
        const h = new CryptoHasher("sha1");
        h.update(encoder.encode(input));
        return h.digest("base64");
      };

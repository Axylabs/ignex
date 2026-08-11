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
export const bunGzipSync: GzipFn | null = isFn(gzipRaw)
  ? (data: Uint8Array, level?: number) => gzipRaw(data, { level })
  : null;

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
    ) => { update(data: Uint8Array): void; digest(): Uint8Array })
  | undefined;
/** HMAC-SHA256 via `Bun.CryptoHasher` when available (~1.2x faster than Rust). */
export const bunHmacSha256: HmacFn | null =
  CryptoHasher === undefined
    ? null
    : (key: Uint8Array, data: Uint8Array) => {
        const h = new CryptoHasher("sha256", key);
        h.update(data);
        return h.digest();
      };

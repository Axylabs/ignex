/**
 * @fileoverview Reusable scratch-buffer pool — "sacrifice some memory for
 * long-term performance": transient native-interop buffers (decode scratch,
 * per-request arenas) are borrowed from a small
 * growable pool instead of `new Uint8Array(...)` on every call, so
 * steady-state hot paths stop allocating. Buffers grow on demand (doubling)
 * and never shrink — retained memory is bounded by {@link MAX_POOLED_BYTES}.
 *
 * # Ownership
 * A borrowed buffer is valid ONLY for the duration of one synchronous
 * `withScratch` call. It MUST NOT escape — never return it to callers, store
 * it, or capture it in a closure that outlives the call. Byte results that
 * must outlive the call are copied out with {@link copyView}.
 *
 * # Concurrency
 * The pool is a module singleton. Under Bun each Worker thread gets its own
 * module instance, so the pool is naturally per-thread (mirrors the
 * per-thread HMAC-key LRU in castrum's `rust/ffi.rs`); no locking is needed.
 */

/** Upper bound on a single borrow (defends against pathological growth). */
export const MAX_SCRATCH_BYTES = 16 * 1024 * 1024;

/** Upper bound on total retained (pooled) memory. Larger buffers are dropped on release. */
export const MAX_POOLED_BYTES = 4 * 1024 * 1024;

/** Free-list of reusable buffers (LIFO — most recently released is hottest). */
const pool: Uint8Array[] = [];
let pooledBytes = 0;

/** Grow `min` up to the next power of two, capped at {@link MAX_SCRATCH_BYTES}. */
const nextSize = (min: number): number => {
  const clamped = Math.min(Math.max(min, 1), MAX_SCRATCH_BYTES);
  let size = 16;
  while (size < clamped) size <<= 1;
  return size;
};

/**
 * Borrow a buffer of at least `minBytes`. Prefer {@link withScratch} so the
 * buffer is always returned (even on throw). Oversized requests bypass the
 * pool entirely (they are never retained).
 */
export const acquire = (minBytes: number): Uint8Array => {
  const min = Math.max(minBytes | 0, 1);
  if (min > MAX_SCRATCH_BYTES) return new Uint8Array(min);

  // Smallest-sufficient fit keeps the pool from fragmenting (a tiny request
  // never steals a big buffer and forces a fresh big allocation).
  let bestIdx = -1;
  let bestLen = Infinity;
  for (let i = 0; i < pool.length; i++) {
    const buf = pool[i] as Uint8Array;
    if (buf.byteLength >= min && buf.byteLength < bestLen) {
      bestLen = buf.byteLength;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) {
    const buf = pool.splice(bestIdx, 1)[0] as Uint8Array;
    pooledBytes -= buf.byteLength;
    return buf;
  }
  return new Uint8Array(nextSize(min));
};

/** Return a borrowed buffer to the pool (dropped when too big to retain). */
export const release = (buf: Uint8Array): void => {
  if (buf.byteLength > MAX_POOLED_BYTES) return;
  pooledBytes += buf.byteLength;
  pool.push(buf);
};

/**
 * Borrow a scratch buffer, run `fn` synchronously with it, and always return
 * it to the pool. Nested `withScratch` calls are safe (each borrows its own
 * buffer from the pool).
 */
export const withScratch = <T>(minBytes: number, fn: (buf: Uint8Array) => T): T => {
  const buf = acquire(minBytes);
  try {
    return fn(buf);
  } finally {
    release(buf);
  }
};

/** Copy a view into a fresh exact-size buffer (for results that outlive a borrow). */
export const copyView = (view: Uint8Array): Uint8Array => {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
};

/** Current pool occupancy (observability + tests). */
export const poolStats = (): { count: number; bytes: number } => ({
  count: pool.length,
  bytes: pooledBytes,
});

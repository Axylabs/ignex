/**
 * @fileoverview Off-thread task runtime — castrum 0.9.6's "castrum Tasks".
 *
 * CPU-bound native work (PBKDF2/Argon2id verification, gzip/brotli) can stall
 * the JS event loop for tens-to-hundreds of milliseconds. The native task
 * runtime submits the op to a Rust pool (`cores − 1` threads, separate from the
 * rayon batch pool) and resolves a promise when it finishes, keeping the JS
 * thread free. See castrum's `docs/RND-CONCURRENCY.md`.
 *
 * This bridge is a LAZY, async factory: `createTaskRuntime()` resolves castrum's
 * runtime when the addon ships it, and otherwise returns a pure-TS FALLBACK
 * that runs each op synchronously through the existing `@ignex/native` wrappers
 * (byte-compatible results — the offload is the only difference). Importing
 * this module never throws.
 *
 * @remarks Use the fallback for correctness, not throughput: it blocks the
 * event loop exactly like the non-task call would. `stats().threads === 0`
 * identifies the fallback.
 */
import { pbkdf2Sync } from "node:crypto";
import { passwordVerify } from "./crypto";
import { loadCastrumModule } from "./loader";
import { brotliDecompress, gzipCompress, gzipDecompress } from "./payload";
import { reportDegradation } from "./telemetry";
import { decoder, encoder } from "./util";

/** Per-call options for an offloaded task. */
export interface TaskRunOptions {
  /** Abort the task; it rejects with an `AbortError`. */
  readonly signal?: AbortSignal;
  /** Decompress ops: output cap in bytes (default: the native 64 MiB bomb cap). */
  readonly maxDecompressed?: number;
  /** `gzipCompress` only: deflate level `0`–`9` (default `6`). */
  readonly level?: number;
}

/** Options for {@link TaskRuntime.pbkdf2Sha256}. */
export interface Pbkdf2RunOptions extends TaskRunOptions {
  /** Iteration count (clamped to `>= 1`). */
  readonly rounds: number;
  /** Derived-key length in bytes (default `32`). */
  readonly dkLen?: number;
}

/** Runtime introspection snapshot. */
export interface TaskStats {
  /** Pool worker count (`0` on the pure-TS fallback). */
  readonly threads: number;
  /** Finished-but-undrained completions in the native ring. */
  readonly pending: number;
  /** Promises currently awaiting a completion. */
  readonly inflight: number;
  /** Completions resolved since the runtime was created. */
  readonly completed: number;
  /** Drain rounds run on the JS thread. */
  readonly drains: number;
  /** Largest number of completions carried by a single drain round. */
  readonly maxBatch: number;
  /** Zero-copy attempts that had to retry at the exact needed size. */
  readonly tooSmallRetries: number;
}

/** Off-thread task runtime handle. */
export interface TaskRuntime {
  /** gzip-decompress `data` off-thread (64 MiB bomb cap unless overridden). */
  gzipDecompress(data: Uint8Array, options?: TaskRunOptions): Promise<Uint8Array>;
  /** brotli-decompress `data` off-thread (64 MiB bomb cap unless overridden). */
  brotliDecompress(data: Uint8Array, options?: TaskRunOptions): Promise<Uint8Array>;
  /** gzip-compress `data` off-thread. */
  gzipCompress(data: Uint8Array, options?: TaskRunOptions): Promise<Uint8Array>;
  /** Verify a password against a PHC string off-thread (10–200 ms CPU). */
  argon2Verify(password: Uint8Array, phc: Uint8Array, options?: TaskRunOptions): Promise<boolean>;
  /** PBKDF2-HMAC-SHA256 off-thread (10–200 ms CPU). */
  pbkdf2Sha256(
    password: Uint8Array,
    salt: Uint8Array,
    options: Pbkdf2RunOptions,
  ): Promise<Uint8Array>;
  /** Pool / ring / in-flight counters (`threads === 0` on the fallback). */
  stats(): TaskStats;
  /** Cancel everything in flight and stop the pool (no-op on the fallback). */
  shutdown(): void;
}

/** Options for {@link createTaskRuntime}. */
export interface TaskRuntimeOptions {
  /** Pool worker count; `0`/omitted → the native default (`cores − 1`). */
  readonly threads?: number;
}

/** Minimal structural view of castrum's task-runtime export. */
interface CastrumTaskModule {
  createTaskRuntime?: (options?: TaskRuntimeOptions) => TaskRuntime;
}

let modulePromise: Promise<CastrumTaskModule | null> | null = null;

const loadTaskModule = async (): Promise<CastrumTaskModule | null> => {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    try {
      return (await loadCastrumModule()) as CastrumTaskModule | null;
    } catch {
      return null;
    }
  })();
  return modulePromise;
};

const EMPTY_STATS: TaskStats = {
  threads: 0,
  pending: 0,
  inflight: 0,
  completed: 0,
  drains: 0,
  maxBatch: 0,
  tooSmallRetries: 0,
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new DOMException("The task was aborted", "AbortError");
};

/**
 * Pure-TS fallback runtime: runs each op synchronously through the existing
 * wrappers (byte-compatible output; the offload is the only thing missing).
 */
const createFallbackRuntime = (): TaskRuntime => ({
  async gzipDecompress(data, options) {
    throwIfAborted(options?.signal);
    return gzipDecompress(
      data,
      options?.maxDecompressed === undefined ? {} : { maxOutputBytes: options.maxDecompressed },
    );
  },
  async brotliDecompress(data, options) {
    throwIfAborted(options?.signal);
    return brotliDecompress(
      data,
      options?.maxDecompressed === undefined ? {} : { maxOutputBytes: options.maxDecompressed },
    );
  },
  async gzipCompress(data, options) {
    throwIfAborted(options?.signal);
    return gzipCompress(data, options?.level ?? 6);
  },
  async argon2Verify(password, phc, options) {
    throwIfAborted(options?.signal);
    // The repo's single verification entry point (argon2id needs the addon;
    // `passwordVerify` reports the degradation instead of silently failing).
    return passwordVerify(decoder.decode(password), decoder.decode(phc));
  },
  async pbkdf2Sha256(password, salt, options) {
    throwIfAborted(options.signal);
    const dkLen = Math.max(1, Math.floor(options.dkLen ?? 32));
    const rounds = Math.max(1, Math.floor(options.rounds));
    return new Uint8Array(pbkdf2Sync(password, salt, rounds, dkLen, "sha256"));
  },
  stats: () => EMPTY_STATS,
  shutdown: () => {
    // Nothing to stop on the fallback.
  },
});

/**
 * Create the off-thread task runtime, preferring castrum's native pool and
 * falling back to a synchronous pure-TS runtime. Never throws.
 *
 * @param options - Pool sizing (`threads`); ignored by the fallback.
 * @returns A {@link TaskRuntime} (check `stats().threads > 0` for native).
 */
export const createTaskRuntime = async (options?: TaskRuntimeOptions): Promise<TaskRuntime> => {
  try {
    const mod = await loadTaskModule();
    const create = mod?.createTaskRuntime;
    if (typeof create === "function") {
      const runtime = create(options);
      if (runtime && typeof runtime.gzipDecompress === "function") return runtime;
    }
  } catch (err) {
    reportDegradation(
      "call-failed",
      "createTaskRuntime",
      err instanceof Error ? err.message : String(err),
    );
  }
  return createFallbackRuntime();
};

/** True when the given runtime is backed by the native Rust pool. */
export const isNativeTaskRuntime = (runtime: TaskRuntime): boolean => {
  try {
    return runtime.stats().threads > 0;
  } catch {
    return false;
  }
};

let sharedRuntimePromise: Promise<TaskRuntime> | null = null;

/**
 * Resolve the process-wide shared off-thread runtime, created on first use and
 * reused by every async helper below. The Rust task pool / doorbell is thus not
 * duplicated per call site.
 *
 * @param options - Pool sizing; honored only on the FIRST call (the runtime is
 *   a singleton for the process lifetime).
 * @returns The shared {@link TaskRuntime}.
 */
const getSharedRuntime = (options?: TaskRuntimeOptions): Promise<TaskRuntime> => {
  if (!sharedRuntimePromise) sharedRuntimePromise = createTaskRuntime(options);
  return sharedRuntimePromise;
};

/**
 * gzip-compress `data` off the JS event loop when the native task pool is
 * available. The output is a valid gzip stream that decompresses to the same
 * payload as the synchronous `gzipCompress`; on the pure-TS fallback it runs
 * synchronously (no pool exists) and therefore blocks exactly like
 * `gzipCompress`.
 *
 * @param data - Bytes to compress.
 * @param options - Deflate `level` (0–9) and an optional abort signal.
 * @returns The gzip bytes.
 */
export const gzipCompressAsync = async (
  data: Uint8Array,
  options?: TaskRunOptions,
): Promise<Uint8Array> => (await getSharedRuntime()).gzipCompress(data, options);

/**
 * Verify a password against a PHC string off the JS event loop (argon2id is
 * 10–200 ms of CPU that would otherwise stall the loop).
 *
 * Only argon2id hashes offload; `$scrypt$` hashes, a missing task runtime and
 * `IGNEX_NATIVE=off` fall back to the synchronous {@link passwordVerify}, so
 * the boolean result is identical whichever path runs.
 *
 * @param password - Cleartext password.
 * @param phc - Stored PHC hash (`$argon2id$…` or `$scrypt$…`).
 * @param options - Optional abort signal.
 * @returns `true` when the password matches the hash.
 */
export const verifyPasswordAsync = async (
  password: string,
  phc: string,
  options?: TaskRunOptions,
): Promise<boolean> => {
  throwIfAborted(options?.signal);
  if (!phc.startsWith("$argon2")) {
    // scrypt (and any foreign PHC) stays on the synchronous dispatcher.
    return passwordVerify(password, phc);
  }
  try {
    const runtime = await getSharedRuntime();
    return await runtime.argon2Verify(encoder.encode(password), encoder.encode(phc), options);
  } catch (err) {
    // Never let an offload failure turn a valid credential into a 500: report
    // and run the same verification synchronously.
    reportDegradation(
      "call-failed",
      "verifyPasswordAsync",
      err instanceof Error ? err.message : String(err),
    );
    return passwordVerify(password, phc);
  }
};

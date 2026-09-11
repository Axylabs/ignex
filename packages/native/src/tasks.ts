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
import { decoder } from "./util";

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

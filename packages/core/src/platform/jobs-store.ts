/**
 * Durable background jobs — storage layer.
 *
 * The in-process queue in `./jobs` is memory-only. For durability we add a
 * `JobStore` abstraction over serializable job records (`StoredJob`) with a
 * driver-backed implementation built on the generic `data/store` layer:
 *
 * - {@link createFileJobStore} — JSON-lines file (portable `node:fs`), the
 *   default for any runtime;
 * - {@link createSqliteJobStore} — `bun:sqlite`-backed (WAL mode), gated on
 *   availability;
 * - {@link openStoreJobStore} — wrap ANY {@link Store} driver (including ASYNC
 *   ones such as Redis) as a durable job store. This is the canonical factory.
 *
 * ## Multi-process safety model
 *
 * Earlier revisions kept ONE construction-time in-memory snapshot and rewrote
 * it under a single key — two workers shared stale state, claimed the same
 * jobs from it, and last-writer-wins clobbered the other's records (lost
 * updates AND double runs). This revision fixes the failure modes that made
 * the queue single-writer:
 *
 * 1. **Fresh read-modify-write** — every operation re-reads the job map from
 *    the store before mutating. A second worker now SEES the first worker's
 *    `running` stamp instead of claiming from a stale snapshot.
 * 2. **Owner-token leases** — each claim mints a random `leaseOwner` token;
 *    `complete`/`fail`/`heartbeat` verify ownership before applying, so the
 *    loser of any residual race cannot mark someone else's job done (the
 *    classic double-run/double-complete bug).
 * 3. **Per-job claims** — `claimOne(id)` lets schedulers claim exactly the job
 *    they enqueued instead of "any due job".
 *
 * What this does NOT provide: strict linearizability on a single-key store
 * under concurrent writers (two interleaved read-modify-write cycles can still
 * last-writer-wins). For exactly-once semantics at high concurrency use a
 * backend with native atomic operations (Redis Lua / SQL row updates) via a
 * custom `JobStore`. Completed/failed history is bounded by the `retention`
 * option so the map cannot grow forever.
 */

import { randomToken } from "@ignex/native";
import { createFileStore } from "../data/store/file";
import { createSqliteStore } from "../data/store/sqlite";
import type { MaybePromise, Store } from "../data/store/types";

/** The lifecycle status of a durable job. */
export type JobStatus = "queued" | "running" | "completed" | "failed";

/** A serializable, durable job record. */
export interface StoredJob {
  readonly id: string;
  readonly name: string;
  payload?: unknown;
  /** Epoch ms before which the job should not run. */
  runAt: number;
  /** Re-enqueue every `intervalMs` after completion (recurring durable jobs). */
  intervalMs?: number;
  /** Number of completed attempts so far. */
  attempts: number;
  maxAttempts: number;
  status: JobStatus;
  /** Epoch ms lease expiry; set while running. */
  leaseUntil?: number;
  /**
   * Random token minted by the worker that claimed this job. Ownership guard:
   * bookkeeping from a different worker is ignored (prevents cross-process
   * double-runs after a lease race).
   */
  leaseOwner?: string;
  lastError?: string;
  readonly createdAt: number;
}

/** Options accepted by completion methods (ownership verification). */
export interface JobCompletionOptions {
  /**
   * The `leaseOwner` token returned by `claim`. When given, the mutation only
   * applies if the job is STILL owned by this token — otherwise it is a no-op
   * (another worker won the lease).
   */
  owner?: string;
}

/**
 * A pluggable persistent store for durable jobs (file, SQLite, custom driver).
 */
export interface JobStore {
  /** Persist a job for future processing. */
  enqueue(job: StoredJob): Promise<void>;
  /**
   * Atomically claim up to `limit` due (`runAt <= now`, `status: queued`)
   * jobs, marking them running with a `leaseMs` lease. Returns the claimed set.
   */
  claim(limit: number, leaseMs: number, now?: number): Promise<StoredJob[]>;
  /**
   * Claim exactly the job `id` (when it is queued and due) — schedulers use
   * this to pick up THEIR tick without racing unrelated jobs. Returns the
   * claimed job or `null`.
   */
  claimOne?(id: string, leaseMs: number, now?: number): Promise<StoredJob | null>;
  /** Mark a job completed. Honors `options.owner` when given. */
  complete(id: string, options?: JobCompletionOptions): Promise<void>;
  /**
   * Mark a job failed. When `retryAt` is given the job is re-queued to run no
   * earlier than `retryAt`; otherwise it is permanently failed. Honors
   * `options.owner` when given.
   */
  fail(id: string, error: unknown, retryAt?: number, options?: JobCompletionOptions): Promise<void>;
  /** Renew a running job's lease (heartbeat). Honors `options.owner`. */
  heartbeat(id: string, until: number, options?: JobCompletionOptions): Promise<void>;
  /** Re-queue running jobs whose lease expired (crash recovery); returns count. */
  releaseExpired(now?: number): Promise<number>;
  /** All stored jobs (for observability) — reflects the CURRENT store state. */
  list(): Promise<StoredJob[]>;
}

/** Retention bounds for completed/failed job history. */
export interface JobRetentionOptions {
  /** Delete completed/failed jobs older than this many ms (default: forever). */
  maxAgeMs?: number;
  /** Keep at most this many completed/failed jobs (newest kept; default 1000). */
  maxCompleted?: number;
}

/** Options for {@link openStoreJobStore} / {@link createStoreJobStore}. */
export interface StoreJobStoreOptions {
  /** Bounds for completed/failed history (default: keep newest 1000, no age cap). */
  retention?: JobRetentionOptions;
}

let jobIdCounter = 0;

/**
 * Generate a collision-resistant job id (`job-<ts>-<counter>-<rand>`).
 *
 * Previously process-local counters alone (`job-<ts>-<n>`) collided whenever
 * two processes started in the same millisecond — corrupting the shared map.
 * The random suffix makes ids unique across processes.
 */
export const newJobId = (): string => `job-${Date.now()}-${++jobIdCounter}-${randomToken(6)}`;

/** Serialize an error to a short, stable string for `lastError`. */
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The reserved key holding the whole serialized job map. */
const JOBS_KEY = "__jobs";

const DEFAULT_MAX_COMPLETED = 1000;

/** Rehydrate the job map from a store read (`null`/missing → empty map). */
const jobsFromRaw = (raw: unknown): Map<string, StoredJob> => {
  const jobs = new Map<string, StoredJob>();
  if (raw == null || typeof raw !== "object") return jobs;
  for (const [id, job] of Object.entries(raw as Record<string, unknown>)) {
    if (job && typeof job === "object" && typeof (job as StoredJob).id === "string") {
      jobs.set(id, job as StoredJob);
    }
  }
  return jobs;
};

/**
 * Apply retention bounds to a job map IN PLACE: drop entries older than
 * `maxAgeMs`, then keep only the newest `maxCompleted` finished jobs.
 * Returns the number of pruned entries.
 */
const pruneFinished = (
  jobs: Map<string, StoredJob>,
  retention: JobRetentionOptions | undefined,
  now: number,
): number => {
  const maxAgeMs = retention?.maxAgeMs;
  let maxCompleted = retention?.maxCompleted ?? DEFAULT_MAX_COMPLETED;
  let pruned = 0;
  if (maxAgeMs !== undefined && maxAgeMs > 0) {
    const cutoff = now - maxAgeMs;
    for (const [id, job] of jobs) {
      if ((job.status === "completed" || job.status === "failed") && job.createdAt < cutoff) {
        jobs.delete(id);
        pruned += 1;
      }
    }
  }
  const finished = [...jobs.values()]
    .filter((j) => j.status === "completed" || j.status === "failed")
    .sort((a, b) => b.createdAt - a.createdAt);
  if (maxCompleted < 0) maxCompleted = 0;
  for (const job of finished.slice(maxCompleted)) {
    jobs.delete(job.id);
    pruned += 1;
  }
  return pruned;
};

/**
 * Wrap ANY {@link Store} driver as a {@link JobStore} — including ASYNC
 * drivers (Redis et al.). Every operation performs a FRESH read-modify-write
 * against the store (never a cached snapshot), stamps owner tokens on claim,
 * verifies them on completion, and applies retention pruning.
 *
 * @param store - The generic store driver backing this job store.
 * @param options - Retention tuning.
 * @returns A promise resolving to the job store (see {@link JobStore}).
 */
export const openStoreJobStore = async (
  store: Store,
  options: StoreJobStoreOptions = {},
): Promise<JobStore> => buildStoreJobStore(store, options);

/**
 * The single implementation behind both factories: EVERY operation performs a
 * fresh read-modify-write (the multi-process fix), stamps owner tokens on
 * claim, verifies them on bookkeeping, and prunes history per retention.
 */
const buildStoreJobStore = (store: Store, options: StoreJobStoreOptions = {}): JobStore => {
  const retention = options.retention;

  // Fresh read of the CURRENT job map — the core multi-process fix: workers
  // no longer operate on a construction-time snapshot.
  const readJobs = async (): Promise<Map<string, StoredJob>> =>
    jobsFromRaw(await store.get(JOBS_KEY));

  const persist = (jobs: Map<string, StoredJob>, now: number): MaybePromise<void> => {
    pruneFinished(jobs, retention, now);
    return store.set(JOBS_KEY, Object.fromEntries(jobs));
  };

  /**
   * Ownership guard with TS-friendly narrowing: returns the verified job or
   * `undefined` (missing job OR owned by a different token).
   */
  const verifyOwner = (
    job: StoredJob | undefined,
    owner: string | undefined,
  ): StoredJob | undefined => {
    if (!job) return undefined;
    if (owner === undefined) return job; // legacy caller / no ownership check
    return job.leaseOwner === owner ? job : undefined;
  };

  return {
    async enqueue(job) {
      const jobs = await readJobs();
      jobs.set(job.id, job);
      await persist(jobs, Date.now());
    },

    async claim(limit, leaseMs, now = Date.now()) {
      const jobs = await readJobs();
      const due = [...jobs.values()]
        .filter((job) => job.status === "queued" && job.runAt <= now)
        .sort((a, b) => a.runAt - b.runAt)
        .slice(0, Math.max(0, limit));

      const claimed: StoredJob[] = [];
      for (const job of due) {
        job.status = "running";
        job.leaseUntil = now + leaseMs;
        job.leaseOwner = randomToken(12);
        claimed.push(job);
      }
      if (claimed.length > 0) await persist(jobs, now);
      return claimed.map((job) => ({ ...job }));
    },

    async claimOne(id, leaseMs, now = Date.now()) {
      const jobs = await readJobs();
      const job = jobs.get(id);
      if (job?.status !== "queued" || job.runAt > now) return null;
      job.status = "running";
      job.leaseUntil = now + leaseMs;
      job.leaseOwner = randomToken(12);
      await persist(jobs, now);
      return { ...job };
    },

    async complete(id, completionOptions) {
      const jobs = await readJobs();
      const job = verifyOwner(jobs.get(id), completionOptions?.owner);
      if (!job) return;
      job.status = "completed";
      delete job.leaseUntil;
      delete job.leaseOwner;
      await persist(jobs, Date.now());
    },

    async fail(id, error, retryAt, completionOptions) {
      const jobs = await readJobs();
      const job = verifyOwner(jobs.get(id), completionOptions?.owner);
      if (!job) return;
      job.attempts += 1;
      job.lastError = errorMessage(error);
      delete job.leaseUntil;
      if (retryAt !== undefined) {
        job.status = "queued";
        job.runAt = retryAt;
        // Retry hands the job back to the pool: clear ownership so any
        // worker can claim it.
        delete job.leaseOwner;
      } else {
        job.status = "failed";
        delete job.leaseOwner;
      }
      await persist(jobs, Date.now());
    },

    async heartbeat(id, until, completionOptions) {
      const jobs = await readJobs();
      const job = verifyOwner(jobs.get(id), completionOptions?.owner);
      if (job?.status !== "running") return;
      job.leaseUntil = until;
      await persist(jobs, Date.now());
    },

    async releaseExpired(now = Date.now()) {
      const jobs = await readJobs();
      let released = 0;
      for (const job of jobs.values()) {
        if (job.status === "running" && (job.leaseUntil ?? 0) < now) {
          job.status = "queued";
          delete job.leaseUntil;
          delete job.leaseOwner;
          released += 1;
        }
      }
      if (released > 0) await persist(jobs, now);
      return released;
    },

    async list() {
      const jobs = await readJobs();
      return [...jobs.values()].map((job) => ({ ...job }));
    },
  };
};

/**
 * Synchronous variant of {@link openStoreJobStore} for SYNC-capable drivers
 * (memory/file/sqlite). Kept for backward compatibility — new code should
 * prefer {@link openStoreJobStore}, which also accepts async drivers (Redis).
 * Behavior is IDENTICAL (fresh read-modify-write per op); the only difference
 * is that this factory throws on async drivers instead of awaiting them.
 *
 * @throws TypeError when the store's initial read is asynchronous.
 */
export const createStoreJobStore = (store: Store, options: StoreJobStoreOptions = {}): JobStore => {
  if (store.get(JOBS_KEY) instanceof Promise) {
    throw new TypeError(
      "createStoreJobStore requires a store with synchronous reads (memory/file/sqlite); " +
        "use `await openStoreJobStore(store)` for async drivers (Redis et al).",
    );
  }
  return buildStoreJobStore(store, options);
};

/** JSON-lines file store — portable across Bun and Node. */
export const createFileJobStore = (dir: string, options: StoreJobStoreOptions = {}): JobStore =>
  createStoreJobStore(createFileStore(dir, { file: "jobs.jsonl" }), options);

/**
 * SQLite-backed store via `bun:sqlite` (WAL mode + busy timeout — see the
 * sqlite driver). Returns `null` when the module is unavailable (e.g. running
 * on Node without the polyfill) so callers can fall back to the file store.
 */
export const createSqliteJobStore = async (
  file = ":memory:",
  options: StoreJobStoreOptions = {},
): Promise<JobStore | null> => {
  const store = await createSqliteStore(file, {
    table: "jobs",
    keyColumn: "id",
    valueColumn: "data",
  });
  return store ? openStoreJobStore(store, options) : null;
};

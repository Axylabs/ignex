/**
 * Durable background jobs — storage layer.
 *
 * The in-process queue in `./jobs` is memory-only. For durability we add a
 * `JobStore` abstraction over serializable job records (`StoredJob`) with a
 * driver-backed implementation built on the generic `data/store` layer:
 *
 * - {@link createFileJobStore} — JSON-lines file (portable `node:fs`), the
 *   default for any runtime;
 * - {@link createSqliteJobStore} — `bun:sqlite`-backed, gated on availability
 *   (returns `null` when `bun:sqlite` is unavailable, so callers can fall
 *   back to the file store);
 * - {@link createStoreJobStore} — wrap ANY `Store` driver (memory, sqlite,
 *   file, or a user's custom driver) as a durable job store.
 *
 * Jobs are claimed with a lease; a crashed worker's leases expire and are
 * re-queued by {@link JobStore.releaseExpired}. Completed/failed jobs are kept
 * for observability (`list`).
 *
 * The whole job map is persisted under a single reserved key, so any store
 * driver (sync or async, any backend) can back the queue — the Laravel-style
 * "bring your own driver" story.
 */

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
  lastError?: string;
  readonly createdAt: number;
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
  /** Mark a job completed. */
  complete(id: string): Promise<void>;
  /**
   * Mark a job failed. When `retryAt` is given the job is re-queued to run no
   * earlier than `retryAt`; otherwise it is permanently failed.
   */
  fail(id: string, error: unknown, retryAt?: number): Promise<void>;
  /** Renew a running job's lease (heartbeat). */
  heartbeat(id: string, until: number): Promise<void>;
  /** Re-queue running jobs whose lease expired (crash recovery); returns count. */
  releaseExpired(now?: number): Promise<number>;
  /** All stored jobs (for observability). */
  list(): Promise<StoredJob[]>;
}

/** Monotonic job-id generator (process-local; files store whatever is given). */
let durableJobIdCounter = 0;
/** Generate a monotonic process-local job id (`job-<ts>-<n>`). */
export const newJobId = (): string => `job-${Date.now()}-${++durableJobIdCounter}`;

/** Serialize an error to a short, stable string for `lastError`. */
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The reserved key holding the whole serialized job map. */
const JOBS_KEY = "__jobs";

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
 * Wrap any {@link Store} driver as a {@link JobStore}.
 *
 * The whole job map is kept in memory (matching the previous file/SQLite
 * stores) and persisted under the reserved `__jobs` key on every mutation.
 * The initial load must be synchronous (memory/file/sqlite drivers are; a
 * custom async driver must be pre-warmed before being passed here).
 *
 * @param store - The generic store driver backing this job store.
 * @returns The job store (see {@link JobStore}).
 * @throws TypeError when the store's initial read is asynchronous.
 */
export const createStoreJobStore = (store: Store): JobStore => {
  const raw = store.get(JOBS_KEY);
  if (raw instanceof Promise) {
    throw new TypeError(
      "createStoreJobStore requires a store with synchronous reads (memory/file/sqlite); " +
        "pre-warm async drivers before passing them in.",
    );
  }
  const jobs = jobsFromRaw(raw);

  const save = (): MaybePromise<void> => store.set(JOBS_KEY, Object.fromEntries(jobs));

  return {
    async enqueue(job) {
      jobs.set(job.id, job);
      await save();
    },

    async claim(limit, leaseMs, now = Date.now()) {
      const due = [...jobs.values()]
        .filter((job) => job.status === "queued" && job.runAt <= now)
        .sort((a, b) => a.runAt - b.runAt)
        .slice(0, Math.max(0, limit));

      const claimed: StoredJob[] = [];
      for (const job of due) {
        job.status = "running";
        job.leaseUntil = now + leaseMs;
        claimed.push(job);
      }
      if (claimed.length > 0) await save();
      return claimed;
    },

    async complete(id) {
      const job = jobs.get(id);
      if (!job) return;
      job.status = "completed";
      delete job.leaseUntil;
      await save();
    },

    async fail(id, error, retryAt) {
      const job = jobs.get(id);
      if (!job) return;
      job.attempts += 1;
      job.lastError = errorMessage(error);
      delete job.leaseUntil;
      if (retryAt !== undefined) {
        job.status = "queued";
        job.runAt = retryAt;
      } else {
        job.status = "failed";
      }
      await save();
    },

    async heartbeat(id, until) {
      const job = jobs.get(id);
      if (job?.status !== "running") return;
      job.leaseUntil = until;
      await save();
    },

    async releaseExpired(now = Date.now()) {
      let released = 0;
      for (const job of jobs.values()) {
        if (job.status === "running" && (job.leaseUntil ?? 0) < now) {
          job.status = "queued";
          delete job.leaseUntil;
          released += 1;
        }
      }
      if (released > 0) await save();
      return released;
    },

    async list() {
      return [...jobs.values()];
    },
  };
};

/** JSON-lines file store — portable across Bun and Node. */
export const createFileJobStore = (dir: string): JobStore =>
  createStoreJobStore(createFileStore(dir, { file: "jobs.jsonl" }));

/**
 * SQLite-backed store via `bun:sqlite`. Returns `null` when the module is
 * unavailable (e.g. running on Node without the polyfill) so callers can fall
 * back to the file store.
 */
export const createSqliteJobStore = async (file = ":memory:"): Promise<JobStore | null> => {
  const store = await createSqliteStore(file, {
    table: "jobs",
    keyColumn: "id",
    valueColumn: "data",
  });
  return store ? createStoreJobStore(store) : null;
};

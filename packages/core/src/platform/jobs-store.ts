/**
 * Durable background jobs — storage layer.
 *
 * The in-process queue in `./jobs` is memory-only. For durability we add a
 * `JobStore` abstraction over serializable job records (`StoredJob`) with two
 * implementations:
 *
 * - {@link createFileJobStore} — JSON-lines file (portable `node:fs`), the
 *   default for any runtime;
 * - {@link createSqliteJobStore} — `bun:sqlite`-backed, gated on availability
 *   (returns `null` when `bun:sqlite` is unavailable, so callers can fall
 *   back to the file store).
 *
 * Jobs are claimed with a lease; a crashed worker's leases expire and are
 * re-queued by {@link JobStore.releaseExpired}. Completed/failed jobs are kept
 * for observability (`list`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * A pluggable persistent store for durable jobs (file, SQLite, …).
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

type Persist = (jobs: ReadonlyMap<string, StoredJob>) => void;

/**
 * Shared in-memory job map + persistence hook. Both the file and SQLite stores
 * are this core with a different `load`/`persist`.
 */
const createBackedJobStore = (load: () => Map<string, StoredJob>, persist: Persist): JobStore => {
  const jobs = load();

  const save = (): void => persist(jobs);

  return {
    async enqueue(job) {
      jobs.set(job.id, job);
      save();
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
      if (claimed.length > 0) save();
      return claimed;
    },

    async complete(id) {
      const job = jobs.get(id);
      if (!job) return;
      job.status = "completed";
      delete job.leaseUntil;
      save();
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
      save();
    },

    async heartbeat(id, until) {
      const job = jobs.get(id);
      if (job?.status !== "running") return;
      job.leaseUntil = until;
      save();
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
      if (released > 0) save();
      return released;
    },

    async list() {
      return [...jobs.values()];
    },
  };
};

/** JSON-lines file store — portable across Bun and Node. */
export const createFileJobStore = (dir: string): JobStore => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "jobs.jsonl");

  const load = (): Map<string, StoredJob> => {
    const jobs = new Map<string, StoredJob>();
    if (!existsSync(file)) return jobs;
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const job = JSON.parse(trimmed) as StoredJob;
        if (job && typeof job.id === "string") jobs.set(job.id, job);
      } catch {
        // Skip corrupt lines; the rest of the log stays usable.
      }
    }
    return jobs;
  };

  const persist = (jobs: ReadonlyMap<string, StoredJob>): void => {
    const tmp = `${file}.tmp`;
    const lines = [...jobs.values()].map((job) => JSON.stringify(job)).join("\n");
    writeFileSync(tmp, lines ? `${lines}\n` : "");
    renameSync(tmp, file);
  };

  return createBackedJobStore(load, persist);
};

/**
 * SQLite-backed store via `bun:sqlite`. Returns `null` when the module is
 * unavailable (e.g. running on Node without the polyfill) so callers can fall
 * back to the file store.
 */
export const createSqliteJobStore = async (file = ":memory:"): Promise<JobStore | null> => {
  let Database: new (path: string) => unknown;
  try {
    const specifier = "bun:sqlite";
    const mod: any = await import(specifier);
    Database = mod.Database;
    if (typeof Database !== "function") return null;
  } catch {
    return null;
  }

  const db = new Database(file);
  (db as { run: (sql: string) => unknown }).run(
    "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );

  const load = (): Map<string, StoredJob> => {
    const jobs = new Map<string, StoredJob>();
    const rows = (db as { query: (sql: string) => { all: () => Array<{ data: string }> } })
      .query("SELECT data FROM jobs")
      .all();
    for (const row of rows) {
      try {
        const job = JSON.parse(row.data) as StoredJob;
        if (job && typeof job.id === "string") jobs.set(job.id, job);
      } catch {
        // Skip corrupt rows.
      }
    }
    return jobs;
  };

  const persist = (jobs: ReadonlyMap<string, StoredJob>): void => {
    const run = (db as { run: (sql: string, params?: unknown[]) => unknown }).run.bind(db);
    for (const job of jobs.values()) {
      run(
        "INSERT INTO jobs (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        [job.id, JSON.stringify(job)],
      );
    }
  };

  return createBackedJobStore(load, persist);
};

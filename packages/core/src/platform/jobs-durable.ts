/**
 * Durable background jobs — durable queue.
 *
 * A worker-style queue on top of a {@link JobStore}. Unlike the in-process
 * `createJobQueue` (closures, memory-only), durable jobs are serializable
 * records (`name` + JSON `payload`) routed to a handler registry. A poll loop
 * claims due jobs under a lease, runs the registered handler, and records
 * completion/failure. Crashed workers' leases expire and the jobs are re-queued
 * automatically.
 */

import { type JobStore, newJobId, type StoredJob } from "./jobs-store";

/**
 * Maximum time `stop()` waits for in-flight claims to settle before giving up
 * (a never-resolving task must not hang graceful shutdown forever).
 */
const STOP_DEADLINE_MS = 5_000;

/** A serializable job to enqueue. */
export interface DurableJobSpec {
  /** Handler name (must exist in the `handlers` registry). */
  name: string;
  /** JSON-serializable payload passed to the handler. */
  payload?: unknown;
  /** Epoch ms before which the job should not run (default: now). */
  runAt?: number;
  /** Re-enqueue every `intervalMs` ms after completion (recurring durable jobs). */
  intervalMs?: number;
  /** Total attempts before the job is marked failed (default 1). */
  maxAttempts?: number;
}

/** A handler that runs a durable job; receives the payload and attempt number. */
export type JobHandler = (payload: unknown, ctx: { attempt: number }) => Promise<void> | void;

/** Options for {@link createDurableJobQueue}. */
export interface DurableJobQueueOptions {
  /** Persistent job store. */
  store: JobStore;
  /** Handler registry keyed by job name. */
  handlers: Record<string, JobHandler>;
  /** Maximum jobs running concurrently (default 1). */
  concurrency?: number;
  /** Claim-loop poll interval in ms (default 250). */
  pollIntervalMs?: number;
  /**
   * Max ms `stop()` waits for in-flight claims before giving up (default 5000).
   * A stuck task must never hang graceful shutdown forever.
   */
  stopDeadlineMs?: number;
  /** Lease duration in ms for claimed jobs (default 60_000). */
  leaseMs?: number;
  /** Called when a job completes successfully. */
  onComplete?: (job: StoredJob) => void;
  /** Called when a job exhausts its attempts and is permanently failed. */
  onFailed?: (job: StoredJob, error: unknown) => void;
  /** Called when a job fails but will be retried. */
  onRetry?: (job: StoredJob, error: unknown, attempt: number) => void;
  /** Called on worker-loop errors (store failures, etc.). */
  onError?: (error: unknown) => void;
}

/**
 * A durable background job queue over a persistent {@link JobStore}.
 */
export interface DurableJobQueue {
  /** Persist a job; it runs when due. */
  enqueue(spec: DurableJobSpec): Promise<StoredJob>;
  /** Begin the claim loop (idempotent). */
  start(): void;
  /** Stop the loop and wait for in-flight jobs to settle. */
  stop(): Promise<void>;
  /** All stored jobs (observability). */
  list(): Promise<StoredJob[]>;
  /** Approximate number of queued (not-yet-started) jobs. */
  readonly pending: number;
  /** Number of currently running jobs. */
  readonly running: number;
}

/** Exponential backoff for retries (mirrors `withRetry`'s 100ms base). */
const backoffFor = (attempt: number): number => 100 * 2 ** (attempt - 1);

/**
 * Create a durable background job queue.
 *
 * @param options - Store, handler registry, and worker tuning.
 * @returns The queue (see {@link DurableJobQueue}). Call `start()` to run it.
 */
export const createDurableJobQueue = (options: DurableJobQueueOptions): DurableJobQueue => {
  const { store, handlers, concurrency = 1, pollIntervalMs = 250, leaseMs = 60_000 } = options;

  const inFlight = new Map<string, Promise<void>>();
  let running = 0;
  let pending = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const runClaimed = async (job: StoredJob): Promise<void> => {
    const handler = handlers[job.name];
    if (!handler) {
      await store.fail(job.id, new Error(`No handler registered for job '${job.name}'`));
      return;
    }

    try {
      await handler(job.payload, { attempt: job.attempts + 1 });
      await store.complete(job.id);

      if (job.intervalMs != null) {
        // Recurring durable job: re-enqueue for the next interval.
        const next: StoredJob = {
          ...job,
          id: newJobId(),
          runAt: Date.now() + job.intervalMs,
          status: "queued",
          attempts: 0,
        };
        // Clear the completion/lease state carried over from the old record.
        delete next.lastError;
        delete next.leaseUntil;
        await store.enqueue(next);
        pending += 1;
      }

      options.onComplete?.(job);
    } catch (error) {
      const attempt = job.attempts + 1;
      if (attempt >= job.maxAttempts) {
        await store.fail(job.id, error);
        options.onFailed?.(job, error);
      } else {
        await store.fail(job.id, error, Date.now() + backoffFor(attempt));
        options.onRetry?.(job, error, attempt);
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;

    try {
      const now = Date.now();

      // Renew leases of in-flight jobs every tick so slow jobs are never stolen.
      for (const id of inFlight.keys()) {
        await store.heartbeat(id, now + leaseMs);
      }

      // Recover jobs whose leases expired (crashed workers).
      await store.releaseExpired(now);

      const capacity = Math.max(0, concurrency - running);
      if (capacity === 0) return;

      const claimed = await store.claim(capacity, leaseMs, now);
      pending = Math.max(0, pending - claimed.length);

      for (const job of claimed) {
        // Run the handler + store bookkeeping (complete/fail/enqueue). A store
        // I/O failure inside `runClaimed` rejects the task — surface it via
        // `onError` and always clean up `running`/`inFlight`. Previously this
        // `void task.finally(...)` produced an UNHANDLED rejection that
        // bypassed both `onRetry`/`onFailed` and `onError`.
        running += 1;
        const task = runClaimed(job);
        inFlight.set(job.id, task);
        void task
          .catch((error) => {
            options.onError?.(error);
          })
          .finally(() => {
            running -= 1;
            inFlight.delete(job.id);
          });
      }
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    async enqueue(spec) {
      const job: StoredJob = {
        id: newJobId(),
        name: spec.name,
        ...(spec.payload !== undefined ? { payload: spec.payload } : {}),
        runAt: spec.runAt ?? Date.now(),
        ...(spec.intervalMs !== undefined ? { intervalMs: spec.intervalMs } : {}),
        attempts: 0,
        maxAttempts: spec.maxAttempts ?? 1,
        status: "queued",
        createdAt: Date.now(),
      };
      await store.enqueue(job);
      pending += 1;
      return job;
    },

    start() {
      // A stopped queue can be restarted: clear the flag so `tick()` resumes
      // claiming. Previously `stopped` was never reset, so `start()` after
      // `stop()` reinstalled the interval but every tick returned immediately
      // and lease-expired jobs were never recovered.
      stopped = false;
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, pollIntervalMs);
      timer.unref?.();
      void tick();
    },

    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      // Wait for in-flight claims to settle — but never forever: a stuck task
      // (never-resolving promise, leaked socket) must not hang graceful
      // shutdown. Give up after a deadline and resolve.
      const deadline = Date.now() + (options.stopDeadlineMs ?? STOP_DEADLINE_MS);
      while (running > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },

    list: () => store.list(),

    get pending() {
      return pending;
    },

    get running() {
      return running;
    },
  };
};

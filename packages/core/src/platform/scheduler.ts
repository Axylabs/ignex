/**
 * @fileoverview `createScheduler` — cron-expression scheduling on top of the
 * durable job store.
 *
 * DX over the STANDARD approach (the `croner` parser) plus the existing
 * durable `JobStore` for at-most-once execution:
 *
 *   - **cron expressions** — `croner` syntax (every 5 seconds:
 *     `"*&#47;5 * * * * *"`; daily at 09:00: `"0 9 * * *"`; weekly Monday
 *     midnight: `"0 0 * * 1"`).
 *   - **durable** — every tick enqueues a job into the project's `JobStore`,
 *     so a crash between "due" and "done" recovers via claim/lease; a
 *     `schedule:run` worker (or the same process) picks it up.
 *   - **overlap guard** — when a previous run of the same name is still
 *     queued/running, the tick is skipped (configurable) so slow runs never
 *     pile up.
 *
 * ```ts
 * import { createScheduler, createFileJobStore } from "@ignex/core";
 *
 * const store = await createFileJobStore("./data/jobs");
 * const scheduler = createScheduler({ store });
 *
 * scheduler.cron("0 9 * * *", "morning-digest", async () => { ... });
 * await scheduler.start();  // begin ticking
 * // on shutdown:
 * scheduler.stop();
 * ```
 */
import { Cron } from "croner";
import type { JobStore, StoredJob } from "./jobs-store";

/** A scheduled job handle (tick timer + last enqueued run). */
export interface ScheduledJob {
  readonly name: string;
  readonly expression: string;
  /** Stop ticking for this job (in-flight runs finish). */
  stop(): void;
  /** True while the underlying cron timer is active. */
  readonly running: boolean;
}

/** Options for {@link createScheduler}. */
export interface SchedulerOptions {
  /** The durable job store backing every scheduled run. */
  store: JobStore;
  /**
   * Skip a tick when the previous run of the same name is still queued or
   * running (default true — prevents pile-up).
   */
  skipWhenInFlight?: boolean;
  /** Optional sink for scheduler diagnostics (default `console`). */
  log?: (message: string) => void;
}

/** The scheduler surface. */
export interface Scheduler {
  /**
   * Schedule `task` on a cron expression. Each tick enqueues a durable job
   * named `name`; a worker (or `schedule:run`) executes it exactly once.
   */
  cron(expression: string, name: string, task: () => Promise<void> | void): ScheduledJob;
  /** Begin ticking all scheduled jobs. Idempotent. */
  start(): void;
  /** Stop all tick timers (in-flight runs finish; durable jobs persist). */
  stop(): void;
  /** Names of all scheduled jobs. */
  readonly jobs: readonly string[];
}

let jobIdCounter = 0;
const newJobId = (): string => `sched-${Date.now()}-${++jobIdCounter}`;

/** True when a job named `name` is queued or running (a run is in flight). */
async function hasInFlight(store: JobStore, name: string): Promise<boolean> {
  try {
    const all = await store.list();
    return all.some((job) => job.name === name && job.status !== "completed");
  } catch {
    return false; // store unavailable — don't block the schedule
  }
}

/**
 * Create a cron scheduler backed by a durable job store.
 */
export const createScheduler = (options: SchedulerOptions): Scheduler => {
  const skipWhenInFlight = options.skipWhenInFlight ?? true;
  const log = options.log ?? ((message: string) => console.log(`[scheduler] ${message}`));
  const jobs = new Map<string, Cron>();

  return {
    cron(expression, name, task) {
      jobs.get(name)?.stop();
      const cron = new Cron(expression, { paused: true }, () => {
        void (async () => {
          if (skipWhenInFlight && (await hasInFlight(options.store, name))) {
            log(`skip ${name} — previous run still in flight`);
            return;
          }
          const run: StoredJob = {
            id: newJobId(),
            name,
            payload: { cron: expression, tickedAt: Date.now() },
            status: "queued",
            runAt: Date.now(),
            attempts: 0,
            maxAttempts: 1,
            createdAt: Date.now(),
          };
          try {
            await options.store.enqueue(run);
            // Single-process apps: run inline if no worker claims it first.
            void runIfUnclaimed(options.store, run, task, log);
          } catch (error) {
            log(
              `enqueue error for ${name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })();
      });
      jobs.set(name, cron);
      return {
        name,
        expression,
        stop: () => cron.stop(),
        get running() {
          return cron.isStopped ? !cron.isStopped() : false;
        },
      };
    },

    start() {
      for (const cron of jobs.values()) cron.resume();
    },

    stop() {
      for (const cron of jobs.values()) cron.stop();
    },

    get jobs() {
      return [...jobs.keys()];
    },
  };
};

/**
 * If a tick's job is never claimed by a worker within ~1s (single-process
 * apps), run it inline and mark it done. If a `schedule:run` worker claims it
 * first, this no-ops (the worker runs it).
 */
async function runIfUnclaimed(
  store: JobStore,
  job: StoredJob,
  task: () => Promise<void> | void,
  log: (message: string) => void,
): Promise<void> {
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const claimed = await store.claim(1, 30_000);
    const mine = claimed.find((c) => c.id === job.id);
    if (!mine) return; // a worker claimed it first
    try {
      await task();
      await store.complete(mine.id).catch(() => {});
    } catch (error) {
      log(`run failed for ${job.name}: ${error instanceof Error ? error.message : String(error)}`);
      await store.complete(mine.id).catch(() => {});
    }
  } catch {
    // claim failed — a worker will handle it
  }
}

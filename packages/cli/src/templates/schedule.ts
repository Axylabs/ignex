/**
 * `src/schedule.ts` template — the schedule:run worker entry.
 *
 * Generates a file that:
 *   - creates the durable job store + queue (handlers keyed by job name);
 *   - creates a `createScheduler` that enqueues a durable job per cron tick
 *     (inline run DISABLED — `schedule:run` owns execution, so replicas never
 *     double-run);
 *   - exports `start()` / `stop()` for `ignex schedule:run`.
 *
 *   schedule.cron("<expr>", "<name>", handler)  — add jobs here.
 *
 * Expressions use Bun.cron's standard 5-field syntax ("0 9 * * *",
 * "*&#47;5 * * * *", @daily). Second-precision 6-field expressions
 * ("*&#47;5 * * * * *") are also accepted via an in-process fallback (dev/tests).
 */
export const scheduleTemplate =
  (): string => `import { createDurableJobQueue, createFileJobStore, createScheduler } from "@ignex/core";

// The durable store backs BOTH the scheduler (enqueue per tick) and the queue
// (claim + run). File-backed by default — swap for sqlite or a Redis store
// when scaling out.
const store = await createFileJobStore("./data/jobs");

// Handlers keyed by the JOB NAME (the scheduler enqueues under the same name).
const handlers = {
  // "morning-digest": async () => { ... },
} as Record<string, (payload: unknown, ctx: { attempt: number }) => Promise<void> | void>;

const queue = createDurableJobQueue({ store, handlers });

// The scheduler enqueues a durable job per cron tick. Inline run is disabled
// (no runIfUnclaimed) — schedule:run owns execution, so multiple replicas
// never double-run a scheduled job.
const scheduler = createScheduler({ store });

// ── add scheduled jobs here ──────────────────────────────────────────────
// scheduler.cron("0 9 * * *", "morning-digest", async () => { ... });
// scheduler.cron("*/5 * * * *", "health-ping", async () => { ... });

export async function start(): Promise<void> {
  queue.start();      // claim + run due scheduled jobs
  scheduler.start();  // begin ticking (enqueue)
}

export async function stop(): Promise<void> {
  scheduler.stop();
  await queue.stop();
}
`;

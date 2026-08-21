/**
 * @fileoverview `createScheduler` — cron-expression scheduling on top of the
 * durable job store, driven by **Bun.cron** (bun-first, zero external deps).
 *
 * Bun 1.4 ships `Bun.cron`: standard 5-field expressions (`"0 9 * * *"`,
 * `"*&#47;5 * * * *"`, named `@daily`/`@hourly`/…) run on the event loop with a
 * built-in never-overlap guarantee and zero lockfile entries. `Bun.cron.parse`
 * validates expressions at registration and fails fast with a clear error.
 *
 * Legacy croner-style **6-field (second-precision)** expressions such as
 * `"*&#47;5 * * * * *"` — handy for dev pings and tests — are supported through a
 * tiny in-process `setTimeout` matcher (`cron6.ts`), so existing expressions
 * keep working. Both transports funnel into the same durable path:
 *
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

import { nextTick6, validateCron6 } from "./cron6";
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
   *
   * Accepts standard 5-field Bun.cron expressions (`"0 9 * * *"`, `@daily`)
   * and legacy 6-field second-precision expressions (`"*&#47;5 * * * * *"`, run
   * through the in-process fallback).
   */
  cron(expression: string, name: string, task: () => Promise<void> | void): ScheduledJob;
  /** Begin ticking all scheduled jobs. Idempotent. */
  start(): void;
  /** Stop all tick timers (in-flight runs finish; durable jobs persist). */
  stop(): void;
  /** Names of all scheduled jobs. */
  readonly jobs: readonly string[];
}

/** A cancellable tick timer. */
interface TickHandle {
  stop(): void;
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
 * One scheduled tick: skip when the previous run is in flight, enqueue a
 * durable job, then hand off to the inline runner (single-process apps).
 */
async function handleTick(
  store: JobStore,
  name: string,
  expression: string,
  task: () => Promise<void> | void,
  log: (message: string) => void,
  skipWhenInFlight: boolean,
): Promise<void> {
  if (skipWhenInFlight && (await hasInFlight(store, name))) {
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
    await store.enqueue(run);
    // Single-process apps: run inline if no worker claims it first.
    void runIfUnclaimed(store, run, task, log);
  } catch (error) {
    log(`enqueue error for ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Create a cron scheduler backed by a durable job store. Ticks are driven by
 * `Bun.cron` (5-field) with an in-process matcher (6-field) fallback.
 */
export const createScheduler = (options: SchedulerOptions): Scheduler => {
  const skipWhenInFlight = options.skipWhenInFlight ?? true;
  const log = options.log ?? ((message: string) => console.log(`[scheduler] ${message}`));
  const started = { value: false };
  const jobs = new Map<
    string,
    { name: string; expression: string; stopped: boolean; handle: TickHandle }
  >();

  return {
    cron(expression, name, task) {
      jobs.get(name)?.handle.stop();
      const onTick = (): void => {
        if (!started.value) return; // registered paused; start() begins ticking
        void handleTick(options.store, name, expression, task, log, skipWhenInFlight);
      };
      const handle = scheduleTick(expression, onTick); // validates + throws on bad expressions
      const entry = { name, expression, stopped: false, handle };
      jobs.set(name, entry);
      return {
        name,
        expression,
        stop: () => {
          entry.handle.stop();
          entry.stopped = true;
        },
        get running() {
          return !entry.stopped;
        },
      };
    },

    start() {
      started.value = true;
    },

    stop() {
      started.value = false;
      for (const job of jobs.values()) job.handle.stop();
    },

    get jobs() {
      return [...jobs.keys()];
    },
  };
};

/**
 * Choose and arm the tick transport for `expression`:
 *   - 5 fields or a named schedule → `Bun.cron` (validated by `Bun.cron.parse`);
 *   - 6 fields → the in-process second-precision matcher;
 *   - anything else → throws with an actionable message.
 */
function scheduleTick(expression: string, onTick: () => void): TickHandle {
  const kind = resolveTransportKind(expression);
  if (kind === "bun") {
    // `Bun.cron(expression, fn)` runs the function on the event loop with a
    // built-in never-overlap guarantee; the returned handle exposes stop().
    const job = Bun.cron(expression, onTick);
    return { stop: () => job.stop() };
  }
  return scheduleWithMatcher(expression, onTick);
}

/** Classify an expression without arming anything (also validates it). */
export function resolveTransportKind(expression: string): "bun" | "matcher" {
  const parts = expression.trim().split(/\s+/);
  const first = parts[0];
  if (first?.startsWith("@")) {
    assertBunCronParseable(expression); // throws on unknown named schedules
    return "bun";
  }
  if (parts.length === 5) {
    assertBunCronParseable(expression); // throws with Bun's exact error on bad syntax
    return "bun";
  }
  if (parts.length === 6) {
    validateCron6(expression);
    return "matcher";
  }
  throw new Error(
    `invalid cron expression "${expression}": Bun.cron uses 5 fields ` +
      `(minute hour day month weekday) or a named schedule (@daily); ` +
      `6-field second-precision expressions ("*/5 * * * * *") are supported ` +
      `via the in-process fallback`,
  );
}

/**
 * Validate a 5-field / named expression through `Bun.cron.parse` when the Bun
 * global is present (the runtime Bun is the only place `Bun.cron` exists).
 * Under test sandboxes without the global, validation is skipped — the
 * 6-field path always validates via {@link validateCron6}.
 */
function assertBunCronParseable(expression: string): void {
  const parse = (globalThis as { Bun?: { cron?: { parse?: (expression: string) => unknown } } }).Bun
    ?.cron?.parse;
  if (parse !== undefined) parse(expression);
}

/** In-process second-precision transport (legacy 6-field expressions). */
function scheduleWithMatcher(expression: string, onTick: () => void): TickHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = (): void => {
    if (stopped) return;
    const now = new Date();
    const delay = Math.max(nextTick6(expression, now).getTime() - now.getTime(), 0) + 2;
    timer = setTimeout(() => {
      if (stopped) return;
      onTick();
      arm();
    }, delay);
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

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

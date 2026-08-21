/**
 * In-process background jobs — a lightweight task queue with scheduling
 * (`schedule`/`every`/`once`), concurrency limits, retries and timeouts.
 *
 * Composable via the `withRetry` / `withTimeout` higher-order wrappers.
 */
/**
 * Default maximum time `stop()` waits for in-flight tasks to settle before
 * giving up (a never-resolving task must not hang graceful shutdown forever).
 */
const STOP_DEADLINE_MS = 5_000;

/** Options for {@link createJobQueue}. */
export interface JobQueueOptions {
  /** Maximum number of tasks running concurrently (default 1). */
  concurrency?: number;
  /** Called when a task throws (default: swallow). */
  onError?: (error: unknown, task: { name: string }) => void;
  /**
   * Max ms `stop()` waits for in-flight tasks before giving up (default 5000).
   * A stuck task must never hang graceful shutdown forever.
   */
  stopDeadlineMs?: number;
}

/** Scheduling options for {@link JobQueue.schedule}. */
export interface ScheduleOptions {
  /** Delay before the first run, in ms. */
  delay?: number;
  /** Repeat every `interval` ms after the first run. */
  interval?: number;
  /** Run once at this absolute time. */
  when?: Date;
}

/** A scheduled/queued job handle; `cancel()` stops it. */
export interface Job {
  readonly id: string;
  readonly name: string;
  cancel(): void;
}

/**
 * An in-process background job queue with scheduling and concurrency limits.
 */
export interface JobQueue {
  /** Run a task once (optionally delayed / scheduled). */
  schedule(name: string, task: () => Promise<void> | void, options?: ScheduleOptions): Job;
  /** Run a task immediately (queued behind the concurrency limit). */
  enqueue(name: string, task: () => Promise<void> | void): Job;
  /** Run `task` every `ms`. */
  every(name: string, ms: number, task: () => Promise<void> | void): Job;
  /** Run `task` once at `when`. */
  once(name: string, when: Date, task: () => Promise<void> | void): Job;
  /** Wait until the queue is drained and all timers are cleared. */
  stop(): Promise<void>;
  /** Number of queued (not-yet-started) tasks. */
  readonly pending: number;
  /** Number of currently running tasks. */
  readonly running: number;
}

let jobIdCounter = 0;

/** Higher-order wrapper: retry a task `retries` times with backoff. */
export const withRetry =
  (retries: number, backoffMs = 100) =>
  (task: () => Promise<void> | void): (() => Promise<void>) =>
  async () => {
    let attempt = 0;
    for (;;) {
      try {
        await task();
        return;
      } catch (error) {
        attempt += 1;
        if (attempt > retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
      }
    }
  };

/** Higher-order wrapper: abort a task after `ms` and reject with a timeout error. */
export const withTimeout =
  (ms: number) =>
  (task: (signal?: AbortSignal) => Promise<void> | void): (() => Promise<void>) =>
  async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => task(controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Signal cooperative cancellation so the task can stop its work
            // (timers, fetch, loops) instead of running on in the background.
            controller.abort();
            reject(new Error(`Job timed out after ${ms}ms`));
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

/**
 * Create an in-process job queue.
 *
 * @param options - Concurrency and error handling.
 * @returns The queue (see {@link JobQueue}).
 */
export const createJobQueue = (options: JobQueueOptions = {}): JobQueue => {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const onError = options.onError ?? (() => {});

  const queue: Array<{ name: string; task: () => Promise<void>; cancelled?: boolean }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let active = 0;
  let stopped = false;

  const drain = (): void => {
    while (!stopped && active < concurrency && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      // A cancelled queued job is skipped (never starts).
      if (job.cancelled) continue;
      active += 1;
      void (async () => {
        try {
          await job.task();
        } catch (error) {
          onError(error, { name: job.name });
        } finally {
          active -= 1;
          drain();
        }
      })();
    }
  };

  // Internal enqueue — NO stopped guard: timers created before `stop()` may
  // legitimately fire during shutdown and must not throw into the event loop.
  // Public entry points below guard `stopped` and fail loud instead.
  const runUnchecked = (name: string, task: () => Promise<void> | void): Job => {
    const id = `${++jobIdCounter}`;
    const item: { name: string; task: () => Promise<void>; cancelled?: boolean } = {
      name,
      task: () => Promise.resolve().then(task),
    };
    queue.push(item);
    drain();
    return {
      id,
      name,
      cancel: () => {
        // Mark the queued job cancelled so drain() skips it.
        item.cancelled = true;
      },
    };
  };

  // Public enqueue: after `stop()` the queue is dead — enqueueing would
  // silently drop the job. Fail loud so the caller notices the bug.
  const run = (name: string, task: () => Promise<void> | void): Job => {
    if (stopped) {
      throw new Error(`Cannot enqueue job "${name}": the job queue has been stopped.`);
    }
    return runUnchecked(name, task);
  };

  const schedule = (
    name: string,
    task: () => Promise<void> | void,
    options: ScheduleOptions = {},
  ): Job => {
    if (stopped) {
      throw new Error(`Cannot schedule job "${name}": the job queue has been stopped.`);
    }
    const id = `${++jobIdCounter}`;
    const delayMs = options.when
      ? Math.max(0, options.when.getTime() - Date.now())
      : (options.delay ?? 0);

    let interval: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const timer = setTimeout(() => {
      timers.delete(timer);
      if (cancelled || stopped) return;
      if (options.interval != null) {
        interval = setInterval(() => {
          if (cancelled || stopped) return;
          runUnchecked(name, task);
        }, options.interval);
        interval.unref?.();
        timers.add(interval);
      }
      runUnchecked(name, task);
    }, delayMs);

    timer.unref?.();
    timers.add(timer);

    return {
      id,
      name,
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
        timers.delete(timer);
        // Also stop the recurring interval created after the initial delay —
        // previously cancel() only cleared the initial timeout, leaving a
        // running periodic job that could never be stopped.
        if (interval) {
          clearInterval(interval);
          timers.delete(interval);
        }
      },
    };
  };

  return {
    schedule,
    enqueue: run,
    every(name, ms, task) {
      if (stopped) {
        throw new Error(`Cannot schedule recurring job "${name}": the job queue has been stopped.`);
      }
      const interval = setInterval(() => {
        if (stopped) return;
        runUnchecked(name, task);
      }, ms);
      interval.unref?.();
      timers.add(interval);
      return {
        id: `${++jobIdCounter}`,
        name,
        cancel: () => {
          clearInterval(interval);
          timers.delete(interval);
        },
      };
    },
    once(name, when, task) {
      return schedule(name, task, { when });
    },
    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      queue.length = 0;
      // Wait for in-flight tasks to settle — but never forever: a stuck task
      // (never-resolving promise, leaked socket) must not hang graceful
      // shutdown. Give up after a deadline and resolve.
      const deadline = Date.now() + (options.stopDeadlineMs ?? STOP_DEADLINE_MS);
      while (active > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    get pending() {
      return queue.length;
    },
    get running() {
      return active;
    },
  };
};

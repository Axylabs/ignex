/**
 * In-process background jobs — a lightweight task queue with scheduling
 * (`schedule`/`every`/`once`), concurrency limits, retries and timeouts.
 *
 * Composable via the `withRetry` / `withTimeout` higher-order wrappers.
 */
export interface JobQueueOptions {
  /** Maximum number of tasks running concurrently (default 1). */
  concurrency?: number;
  /** Called when a task throws (default: swallow). */
  onError?: (error: unknown, task: { name: string }) => void;
}

export interface ScheduleOptions {
  /** Delay before the first run, in ms. */
  delay?: number;
  /** Repeat every `interval` ms after the first run. */
  interval?: number;
  /** Run once at this absolute time. */
  when?: Date;
}

export interface Job {
  readonly id: string;
  readonly name: string;
  cancel(): void;
}

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

/** Higher-order wrapper: abort a task after `ms`. */
export const withTimeout =
  (ms: number) =>
  (task: () => Promise<void> | void): (() => Promise<void>) =>
  async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(task),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Job timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

export const createJobQueue = (options: JobQueueOptions = {}): JobQueue => {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const onError = options.onError ?? (() => {});

  const queue: Array<{ name: string; task: () => Promise<void> }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let active = 0;
  let stopped = false;

  const drain = (): void => {
    while (!stopped && active < concurrency && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
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

  const run = (name: string, task: () => Promise<void> | void): Job => {
    const id = `${++jobIdCounter}`;
    queue.push({ name, task: () => Promise.resolve().then(task) });
    drain();
    return { id, name, cancel: () => {} };
  };

  const schedule = (
    name: string,
    task: () => Promise<void> | void,
    options: ScheduleOptions = {},
  ): Job => {
    const id = `${++jobIdCounter}`;
    const delayMs = options.when
      ? Math.max(0, options.when.getTime() - Date.now())
      : (options.delay ?? 0);

    const timer = setTimeout(() => {
      timers.delete(timer);
      if (options.interval != null) {
        const interval = setInterval(() => run(name, task), options.interval);
        interval.unref?.();
        timers.add(interval);
      }
      run(name, task);
    }, delayMs);

    timer.unref?.();
    timers.add(timer);

    return {
      id,
      name,
      cancel: () => {
        clearTimeout(timer);
        timers.delete(timer);
      },
    };
  };

  return {
    schedule,
    enqueue: run,
    every(name, ms, task) {
      const interval = setInterval(() => run(name, task), ms);
      interval.unref?.();
      timers.add(interval);
      return { id: `${++jobIdCounter}`, name, cancel: () => clearInterval(interval) };
    },
    once(name, when, task) {
      return schedule(name, task, { when });
    },
    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      queue.length = 0;
      // Wait for in-flight tasks to settle.
      while (active > 0) {
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

/**
 * Offload task queue — a small bounded worker pool that keeps ALL non-essential
 * work (cluster publishes, Redis/state-store writes, presence maintenance) off
 * the WebSocket hot path.
 *
 * Contract:
 *   - `enqueue` is O(1) and never throws; when the queue is full (over
 *     `maxPending`) the NEWEST task is dropped and counted (`drop-newest` —
 *     fresher state is more valuable than stale queued work).
 *   - Tasks may be async; workers await them with bounded concurrency
 *     (`workers`), so one slow Redis call can't stall the loop.
 *   - Errors are caught per task, counted, and forwarded to `onError`
 *     (default: nothing) — a failing task never takes the process down and
 *     never breaks the caller's hot path.
 *   - `close()` stops accepting; `drain()` resolves once queued + in-flight
 *     work has completed (used by graceful shutdown).
 */
export interface TaskQueue {
  readonly pending: number;
  enqueue(task: () => void | Promise<void>): void;
  drain(): Promise<void>;
  close(): void;
  stats(): { queued: number; processed: number; dropped: number; errors: number };
}

export interface TaskQueueOptions {
  /** concurrent workers, default 2 */
  workers?: number;
  /** max queued tasks before drop-newest, default 4096 */
  maxPending?: number;
  onError?: (err: Error) => void;
}

export function createTaskQueue(opts: TaskQueueOptions = {}): TaskQueue {
  const workersN = Math.max(1, opts.workers ?? 2);
  const maxPending = Math.max(1, opts.maxPending ?? 4096);
  const onError = opts.onError;
  const tasks: Array<() => void | Promise<void>> = [];
  let queued = 0;
  let processed = 0;
  let dropped = 0;
  let errors = 0;
  let inflight = 0;
  let stopping = false;

  const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopping && tasks.length === 0) return;
      const task = tasks.shift();
      if (!task) {
        await yieldToLoop();
        continue;
      }
      inflight++;
      try {
        await task();
        processed++;
      } catch (err) {
        errors++;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        inflight--;
      }
    }
  };

  for (let i = 0; i < workersN; i++) void worker();

  return {
    get pending(): number {
      return tasks.length + inflight;
    },
    enqueue(task) {
      if (stopping) return;
      if (tasks.length >= maxPending) {
        dropped++;
        return;
      }
      tasks.push(task);
      queued++;
    },
    async drain() {
      while (tasks.length > 0 || inflight > 0) {
        await yieldToLoop();
      }
    },
    close() {
      stopping = true;
    },
    stats() {
      return { queued, processed, dropped, errors };
    },
  };
}

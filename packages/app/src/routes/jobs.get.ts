import { createJobQueue, withRetry, withTimeout } from "@ignus/core";
import { get } from "@ignus/core/http";

const queue = createJobQueue({
  concurrency: 2,
  onError: (error) => console.error("[jobs] task failed:", error),
});

const counters = new Map<string, number>();

const task = withTimeout(5000)(
  withRetry(
    2,
    50,
  )(async () => {
    const current = (counters.get("ticks") ?? 0) + 1;
    counters.set("ticks", current);
  }),
);

// Kick off a scheduled ticker at module load.
queue.every("demo-tick", 10_000, task);

/** GET /jobs — background jobs: enqueue a task and report queue state. */
export default get(async (ctx) => {
  const job = queue.enqueue("demo", task);

  return ctx.json({
    enqueued: job.name,
    ticks: counters.get("ticks") ?? 0,
    pending: queue.pending,
    running: queue.running,
  });
});

/**
 * Shared job-rig state for the /jobs-rig routes.
 *
 * Jobs are in-process (`createJobQueue`): the POST route enqueues into the
 * module-level queue and the status route polls the module-level map, so both
 * route files must see the same rig. One rig per server process.
 */
import { createJobQueue, withRetry, withTimeout } from "@ignex/core";

/** Lifecycle of a rig job (observed through GET /jobs-rig/:id). */
export type JobState = "queued" | "running" | "done" | "failed";

/** Observable state of one rig job. */
export interface JobRecord {
  state: JobState;
  attempts: number;
}

/** All rig jobs this process has enqueued, keyed by the queue's job id. */
export const jobs = new Map<string, JobRecord>();

/** Single-worker queue so job records transition in enqueue order. */
export const queue = createJobQueue({ concurrency: 1 });

let rigSeq = 0;

/**
 * Enqueue a rig job and return its id.
 *
 * - `"ok"`: one attempt of ~20ms "work", then `done` (wrapped in
 *   `withTimeout(2000)` like any production task).
 * - `"failing"`: always throws; `withRetry(2, 10)` retries it twice with
 *   10ms/20ms exponential backoff → 3 attempts, then `failed`.
 */
export const enqueueRigJob = (kind: "ok" | "failing"): string => {
  const record: JobRecord = { state: "queued", attempts: 0 };
  const work =
    kind === "ok"
      ? withTimeout(2000)(async () => {
          record.state = "running";
          record.attempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          record.state = "done";
        })
      : async () => {
          try {
            await withRetry(
              2,
              10,
            )(async () => {
              record.attempts += 1;
              throw new Error("rig: this job always fails");
            })();
          } catch {
            // withRetry exhausted its budget — surface the terminal state
            // through the status route (the queue's onError only logs).
            record.state = "failed";
          }
        };

  const job = queue.enqueue(`rig-${++rigSeq}`, work);
  jobs.set(job.id, record);
  return job.id;
};

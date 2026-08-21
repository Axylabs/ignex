/**
 * `src/jobs.ts` template — the queue:work worker entry.
 *
 * Registers durable job handlers + the store, and exports start()/stop() for
 * `ignex queue:work`. Enqueue work from anywhere:
 *
 *   import { queue } from "./jobs.js";
 *   await queue.enqueue({ name: "send-email", payload: { to: "x@y.z" } });
 */
export const jobsTemplate =
  (): string => `import { createDurableJobQueue, createFileJobStore } from "@ignex/core";

// The durable store: file-backed by default — swap for sqlite or a Redis store
// when scaling out. Jobs persist across restarts (crash recovery via lease).
const store = await createFileJobStore("./data/jobs");

// Handlers keyed by JOB NAME. Add your jobs here:
const handlers = {
  // "send-email": async (payload, ctx) => { ... },
  // "generate-report": async (payload, ctx) => { ... },
} as Record<string, (payload: unknown, ctx: { attempt: number }) => Promise<void> | void>;

// The queue: claim loop with concurrency 1 (bump for parallel workers).
export const queue = createDurableJobQueue({ store, handlers });

export async function start(): Promise<void> {
  queue.start();
}

export async function stop(): Promise<void> {
  await queue.stop();
}
`;

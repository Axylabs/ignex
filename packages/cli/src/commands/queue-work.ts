/**
 * `ignex queue:work` — run durable background jobs as a worker process.
 *
 * Laravel's `php artisan queue:work` equivalent. Loads the project's
 * `src/jobs.ts` (which registers job handlers + the durable store) and runs
 * the claim loop, so jobs enqueued via `queue.enqueue(...)` (or the
 * scheduler) execute in this process. Multiple `queue:work` replicas share
 * the store — the atomic claim/lease guarantees each job runs once.
 *
 *   ignex queue:work               → run jobs until Ctrl-C
 *   ignex queue:work --once        → process due jobs once, then exit
 *   ignex queue:work --init        → scaffold src/jobs.ts
 *
 * Graceful shutdown: SIGTERM/SIGINT drains in-flight jobs, then exits.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { jobsTemplate } from "../templates/jobs.js";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { exists, writeFileEnsuringDir } from "../utils/fs.js";
import { error, info, step, success } from "../utils/logger.js";

export async function runQueueWork(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    once: { type: "boolean" },
    init: { type: "boolean" },
  });
  const root = resolveRoot(values, positionals);

  const jobsPath = join(root, "src", "jobs.ts");
  if (!(await exists(jobsPath))) {
    if (values.init === true) {
      await writeFileEnsuringDir(jobsPath, jobsTemplate());
      success("Created src/jobs.ts — register handlers, then run `ignex queue:work`.");
      return;
    }
    error(
      "No src/jobs.ts found. Create one (see the cookbook) or run " +
        "`ignex queue:work --init` to scaffold it.",
    );
    process.exitCode = 1;
    return;
  }

  const once = values.once === true;
  step(once ? "Processing due jobs once" : "Queue worker running (claim loop)");

  try {
    const mod = (await import(pathToFileURL(jobsPath).href)) as {
      start?: () => Promise<void> | void;
      stop?: () => Promise<void> | void;
    };
    if (!mod.start) {
      error("src/jobs.ts must export `start()` (register the durable queue + handlers).");
      process.exitCode = 1;
      return;
    }

    await mod.start();
    success(once ? "Due jobs processed." : "Queue worker running — Ctrl-C to stop.");

    if (once) {
      // Give the claim loop a moment to pick up + finish due jobs.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        await mod.stop?.();
      } catch {
        // best-effort drain
      }
      return;
    }

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      info(`received ${signal} — draining jobs`);
      try {
        await mod.stop?.();
      } catch {
        // best-effort drain
      }
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (err) {
    error(`Failed to start queue worker: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/**
 * @fileoverview `ignex schedule:run` — run scheduled jobs as a worker process.
 *
 * The `createScheduler` enqueues a durable job per cron tick; THIS command is
 * the worker that executes them. It loads the project's `src/schedule.ts`
 * (which registers cron jobs via `createScheduler`) and runs the durable
 * queue's claim loop, so scheduled tasks execute exactly once even across
 * multiple `schedule:run` replicas.
 *
 *   ignex schedule:run                  → run the project's src/schedule.ts
 *   ignex schedule:run --once           → process due jobs once, then exit
 *
 * Graceful shutdown: SIGTERM/SIGINT drains in-flight runs, then exits.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import { scheduleTemplate } from "../templates/schedule.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { exists, writeFileEnsuringDir } from "../utils/fs.js";
import { error, info, step, success } from "../utils/logger.js";
import { metaFor } from "./registry.js";

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  once: { type: "boolean", description: "Process due jobs once, then exit" },
  init: { type: "boolean", description: "Scaffold src/schedule.ts when missing" },
  root: { type: "string", valueHint: "dir", description: "Project root" },
} satisfies ArgsDef;

export const scheduleRunCmd = defineCommand({
  meta: metaFor("schedule:run"),
  args: argsDef,
  async run(ctx) {
    await runSchedule(ctx.rawArgs);
  },
});

export default scheduleRunCmd;

/** Run `ignex schedule:run`. */
export async function runSchedule(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);
  const root = await resolveProjectRoot(parsed.root);

  const schedulePath = join(root, "src", "schedule.ts");
  if (!(await exists(schedulePath))) {
    if (parsed.init === true) {
      // Scaffold src/schedule.ts (like `ignex seed --create`).
      await writeFileEnsuringDir(schedulePath, scheduleTemplate());
      success("Created src/schedule.ts — add cron jobs, then run `ignex schedule:run`.");
      return;
    }
    error(
      "No src/schedule.ts found. Create one (see the cookbook) or run " +
        "`ignex schedule:run --init` to scaffold it.",
    );
    process.exitCode = 1;
    return;
  }

  const once = parsed.once === true;
  step(once ? "Processing due scheduled jobs once" : "Running scheduled jobs (claim loop)");

  try {
    const mod = (await import(pathToFileURL(schedulePath).href)) as {
      start?: () => Promise<void> | void;
      stop?: () => Promise<void> | void;
    };
    if (!mod.start) {
      error("src/schedule.ts must export `start()` (register scheduler + queue).");
      process.exitCode = 1;
      return;
    }

    await mod.start();
    success(once ? "Due jobs processed." : "Scheduler worker running — Ctrl-C to stop.");

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

    // Stay alive until SIGTERM/SIGINT, then drain.
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      info(`received ${signal} — draining scheduled jobs`);
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
    error(`Failed to start scheduler: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

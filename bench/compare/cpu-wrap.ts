#!/usr/bin/env bun
/**
 * bench/compare/cpu-wrap.ts — CPU-reporting server wrapper.
 *
 * Runs a comparison participant (`bench/compare/servers/<kind>-server.ts`)
 * in-process and reports its OWN `process.cpuUsage()` when asked to shut
 * down. The runner (`bench/compare/cpu.ts`) uses this to measure CPU per
 * request for each participant.
 *
 * Why a wrapper: `Bun.spawn`'s handle exposes no child CPU accounting, so the
 * child has to report its own. Spawning `bun <this> ` with
 * `COMPARE_SERVER_ENTRY=<abs path>` is behaviourally identical to
 * `bun run <entry>` — the entry is imported and keeps the event loop alive
 * exactly as it does when run directly.
 *
 * Env:
 *   COMPARE_SERVER_ENTRY — absolute path to the participant entry module.
 *
 * Emits one line on shutdown (stdout, flushed before exit):
 *   __CPU_USAGE__ {"user":<µs>,"system":<µs>}
 */

const target = process.env.COMPARE_SERVER_ENTRY;

if (!target) {
  console.error("cpu-wrap: COMPARE_SERVER_ENTRY is not set");
  process.exit(1);
}

await import(target);

/**
 * Report this process's CPU time and exit.
 *
 * The write is flushed through its callback before exiting — `console.log`
 * on a pipe can be dropped when `process.exit` follows immediately, which
 * would silently lose the measurement.
 */
const report = (): void => {
  const { user, system } = process.cpuUsage();
  process.stdout.write(`__CPU_USAGE__ ${JSON.stringify({ user, system })}\n`, () => {
    process.exit(0);
  });
};

process.on("SIGTERM", report);
process.on("SIGINT", report);

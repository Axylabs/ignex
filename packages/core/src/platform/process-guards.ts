/**
 * Process-level crash backstop for production server entries.
 *
 * Bun (like Node) terminates the whole process on an UNHANDLED promise
 * rejection and on an uncaught exception. For a long-lived HTTP server that
 * default is too aggressive: a stray rejection from a user hook or a
 * fire-and-forget promise has already lost its request and the process is
 * otherwise healthy — it should be reported, not fatal. This installs handlers
 * that:
 *
 *  - `unhandledRejection` → report and CONTINUE serving (recoverable; the
 *    request that triggered it has already been answered);
 *  - `uncaughtException` → report and `exit(1)` (process state is undefined
 *    after a synchronous exception; the supervisor restarts a fresh process).
 *
 * Both go through the classified fault pipeline ({@link reportFault}) rather
 * than a raw `console.error`: the output is a redacted, origin/kind-classified
 * block with fix hints — and in production it is deduplicated per 5s window, so
 * a rejection storm under load cannot flood the log. A raw print of an
 * arbitrary rejected value (a driver object, a cyclic record) is exactly the
 * unreadable noise the fault pipeline exists to replace.
 *
 * Installed automatically by `createApp().serve()` and by the AOT-compiled
 * server bootstrap (both own the process). Idempotent — call freely.
 */

import { reportFault } from "./fault-report";

let installed = false;

/** Title shown for an unhandled rejection (recoverable — the server continues). */
const REJECTION_TITLE = "[ignex] unhandled promise rejection — continuing";
/** Title shown for an uncaught exception (fatal — the process exits). */
const EXCEPTION_TITLE = "[ignex] uncaught exception — exiting for restart";

/** Report through the fault pipeline, degrading to a plain line if that itself throws. */
const reportSafely = (thrown: unknown, title: string, label: string): void => {
  try {
    reportFault(thrown, { title, label });
  } catch (reportError) {
    // Reporting must never become the failure: one line, then the throw.
    console.error(`${label}:`, thrown, reportError);
  }
};

/** Install the process-level crash backstop once. No-op when already installed. */
export const installProcessGuards = (): void => {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    // A rejection nobody awaited (e.g. from a user hook or fire-and-forget
    // promise). The triggering request is already handled; keep serving.
    reportSafely(reason, REJECTION_TITLE, "[ignex] unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    // The process state is undefined after a synchronous exception — the only
    // safe move is to report and exit so the supervisor restarts a fresh,
    // consistent process. Do NOT keep serving with possibly-corrupt state.
    reportSafely(err, EXCEPTION_TITLE, "[ignex] uncaught exception");
    process.exit(1);
  });
};

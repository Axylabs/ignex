/**
 * Process-level crash backstop for production server entries.
 *
 * Bun (like Node) terminates the whole process on an UNHANDLED promise
 * rejection and on an uncaught exception. For a long-lived HTTP server that
 * default is too aggressive: a stray rejection from a user hook or a
 * fire-and-forget promise has already lost its request and the process is
 * otherwise healthy — it should be logged, not fatal. This installs handlers
 * that:
 *
 *  - `unhandledRejection` → log and CONTINUE serving (recoverable; the request
 *    that triggered it has already been answered);
 *  - `uncaughtException` → log and `exit(1)` (process state is undefined after
 *    a synchronous exception; the supervisor restarts a fresh process).
 *
 * Installed automatically by `createApp().serve()` and by the AOT-compiled
 * server bootstrap (both own the process). Idempotent — call freely.
 */
let installed = false;

/** Install the process-level crash backstop once. No-op when already installed. */
export const installProcessGuards = (): void => {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    // A rejection nobody awaited (e.g. from a user hook or fire-and-forget
    // promise). The triggering request is already handled; keep serving.
    console.error(
      "[ignex] unhandled promise rejection (continuing):",
      reason instanceof Error ? (reason.stack ?? reason) : reason,
    );
  });
  process.on("uncaughtException", (err) => {
    // The process state is undefined after a synchronous exception — the only
    // safe move is to log and exit so the supervisor restarts a fresh,
    // consistent process. Do NOT keep serving with possibly-corrupt state.
    console.error("[ignex] uncaught exception — exiting for restart:", err);
    process.exit(1);
  });
};

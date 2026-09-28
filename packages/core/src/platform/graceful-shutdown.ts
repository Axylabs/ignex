/**
 * @fileoverview Graceful shutdown on process signals.
 *
 * `SIGTERM`/`SIGINT` default to an immediate, ungraceful exit: in-flight
 * requests are cut off and `stop` hooks never run, which a rolling deploy
 * (Kubernetes, ECS, systemd, `docker stop`) observes as dropped requests. This
 * installs the drain:
 *
 * - first signal → log, run the caller's drain, then `exit(0)`;
 * - a second signal, or the deadline elapsing → `exit(1)` immediately, so one
 *   wedged connection can never hold a deploy hostage.
 *
 * The AOT-generated server emits the same contract inline
 * (`packages/compiler/src/phases/codegen/server.ts`); this is the interpreted
 * `createApp().serve()` counterpart, so both server shapes behave identically
 * under a container stop.
 *
 * It returns a disposer that removes the listeners — a manual `app.stop()` and
 * every test must be able to leave the shared process exactly as it found it.
 */

/** Options for {@link installGracefulShutdown}. */
export interface GracefulShutdownOptions {
  /** Signals to drain on. Default `["SIGTERM", "SIGINT"]`. */
  signals?: readonly NodeJS.Signals[];
  /**
   * Hard deadline for the drain before a forced `exit(1)`. Default 10 000 ms —
   * the same budget the generated server uses.
   */
  deadlineMs?: number;
  /** Exit code after a *completed* drain. Default 0. */
  exitCode?: number;
  /** Exit hook. Default `process.exit`; injectable so tests never exit. */
  exit?: (code: number) => void;
  /** Sink for the informational line. Default `console.log`. */
  log?: (message: string) => void;
  /** Sink for the failure lines. Default `console.error`. */
  logError?: (message: string) => void;
}

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
const DEFAULT_DEADLINE_MS = 10_000;

/**
 * Install the `SIGTERM`/`SIGINT` drain for a long-lived server.
 *
 * @param drain - Runs on the first signal. Must resolve once connections are
 *   drained and plugin resources are closed; a rejection is logged and exits
 *   non-zero rather than hanging.
 * @param options - Signal list, deadline, exit hook and log sinks.
 * @returns A disposer that removes every listener this call installed.
 */
export const installGracefulShutdown = (
  drain: (signal: NodeJS.Signals) => Promise<void> | void,
  options: GracefulShutdownOptions = {},
): (() => void) => {
  const signals = options.signals ?? DEFAULT_SIGNALS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string) => console.error(message));

  let draining = false;
  let exited = false;
  const listeners: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

  // The exit hook must fire exactly once: a second signal, the deadline and a
  // drain that resolves *after* either of those can otherwise all race here.
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const dispose = (): void => {
    for (const { signal, handler } of listeners) process.off(signal, handler);
    listeners.length = 0;
  };

  for (const signal of signals) {
    const handler = (): void => {
      if (draining) {
        logError(`[ignex] second ${signal} — exiting immediately`);
        finish(1);
        return;
      }
      draining = true;
      log(`[ignex] received ${signal} — draining connections`);
      const timer = setTimeout(() => {
        logError(`[ignex] graceful shutdown exceeded ${deadlineMs}ms — forcing exit`);
        finish(1);
      }, deadlineMs);
      timer.unref?.();
      Promise.resolve()
        .then(() => drain(signal))
        .then(() => {
          clearTimeout(timer);
          finish(options.exitCode ?? 0);
        })
        .catch((err) => {
          clearTimeout(timer);
          logError(`[ignex] shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
          finish(1);
        });
    };
    process.on(signal, handler);
    listeners.push({ signal, handler });
  }

  return dispose;
};

/**
 * @fileoverview Structured Logger
 * All side-effecting I/O is centralized here. Compiler phases receive a Logger
 * interface and remain pure except for logging calls.
 */

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Time a phase and log duration. */
  time<T>(label: string, fn: () => T): T;
}

/** No-op logger for tests and silent mode. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  time: (_, fn) => fn(),
};

/** Console logger with emoji prefixes and structured metadata. */
export const consoleLogger = (verbose = false): Logger => ({
  debug(msg, meta) {
    if (verbose) console.log(`[debug] ${msg}`, meta ?? "");
  },
  info(msg, meta) {
    console.log(`ℹ️  ${msg}`, meta ?? "");
  },
  warn(msg, meta) {
    console.warn(`⚠️  ${msg}`, meta ?? "");
  },
  error(msg, meta) {
    console.error(`❌ ${msg}`, meta ?? "");
  },
  time(label, fn) {
    const t0 = performance.now();
    const result = fn();
    const elapsed = (performance.now() - t0).toFixed(2);
    console.log(`⏱️  ${label} completed in ${elapsed}ms`);
    return result;
  },
});

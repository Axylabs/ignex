/**
 * Logger abstraction. The ORM never logs directly — it accepts any logger that
 * satisfies `LoggerLike` (pino, a console wrapper, a test stub, ...). This keeps
 * the package free of logging dependencies while remaining observability-agnostic.
 */
export interface LogFn {
  (obj: Record<string, unknown>, msg?: string): void;
  (msg: string): void;
}

export interface LoggerLike {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

/** A logger that swallows everything. Useful in tests / perf runs. */
export const createNoopLogger = (): LoggerLike => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const fmtObj = (obj: Record<string, unknown>): string => {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
};

/**
 * A tiny console logger matching the `LoggerLike` shape. `level` filters output.
 */
export const createConsoleLogger = (level: LogLevel = "info"): LoggerLike => {
  const threshold = LEVEL_RANK[level];
  const make = (method: "debug" | "info" | "warn" | "error") => {
    const rank = LEVEL_RANK[method];
    const fn: LogFn = (a: unknown, b?: string) => {
      if (rank < threshold) return;
      const obj = typeof a === "string" ? undefined : (a as Record<string, unknown>);
      const msg = typeof a === "string" ? a : b;
      const prefix = obj !== undefined ? fmtObj(obj) : "";
      if (msg && prefix) {
        // eslint-disable-next-line no-console
        console[method](`[${method.toUpperCase()}]`, prefix, msg);
      } else {
        // eslint-disable-next-line no-console
        console[method](`[${method.toUpperCase()}]`, (msg ?? prefix) as string);
      }
    };
    return fn;
  };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
  };
};

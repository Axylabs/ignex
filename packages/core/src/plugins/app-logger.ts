/**
 * @fileoverview App-facing logger facade (`createAppLogger`).
 *
 * A leveled, variadic logging API on top of pino for application code — the
 * scaffold's `src/lib/logger.ts` global `log`. Accepts any mix of values per
 * call (`log.info("order", 42, { orderId })`), renders plain objects as
 * structured fields (pino JSON lines in production) or as pretty,
 * ANSI-colored, human-readable output in development. `child()` binds
 * per-scope context (e.g. `requestId`); an injectable pino logger keeps the
 * facade open for custom transports/serializers.
 */
import pino, { type Logger as PinoLogger } from "pino";
import { REDACT_PATHS, resolveLevel } from "./logger.js";

/** Options for {@link createAppLogger}. */
export interface AppLoggerOptions {
  /**
   * Minimum level to emit. Defaults to `process.env.LOG_LEVEL`, then
   * `"info"` (see {@link resolveLevel}).
   */
  level?: string;
  /**
   * Pretty, human-readable output instead of pino JSON lines. Defaults to a
   * dev-shaped environment (`NODE_ENV !== "production"`); ignored when a
   * `logger` is injected.
   */
  pretty?: boolean;
  /**
   * ANSI colors in pretty mode. Defaults to whether stdout is a TTY; only
   * meaningful when `pretty` is on.
   */
  color?: boolean;
  /**
   * Inject an existing pino logger, skipping construction. When set,
   * `pretty`/`color`/`base`/`redact` are ignored — formatting still applies.
   */
  logger?: PinoLogger;
  /** Static fields merged into every line (replaces the default empty base). */
  base?: Record<string, unknown>;
  /** Extra redaction paths on top of ignex's defaults ({@link REDACT_PATHS}). */
  redact?: string[];
}

/**
 * A leveled, variadic logger for application code.
 *
 * Every method accepts any number of values of any type — strings, numbers,
 * plain objects (JSON), arrays, `Error`s — and renders them sensibly. A
 * single plain object becomes structured fields; everything else is folded
 * into the message text. `child()` returns a scoped logger whose bindings are
 * attached to every line.
 */
export interface AppLogger {
  /** Current minimum level (`"debug" | "info" | "warn" | "error"`, …). */
  readonly level: string;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** A scoped logger with `bindings` attached to every line. */
  child(bindings: Record<string, unknown>): AppLogger;
  /** Raise/lower the minimum level at runtime. */
  setLevel(level: string): void;
}

type LogLevel = "debug" | "info" | "warn" | "error";

/** Key under which `Error`s are attached as structured fields. */
const ERR_KEY = "err";

/* ── pretty rendering ────────────────────────────────────────────────────── */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const LEVEL_META: Record<number, { readonly label: string; readonly ansi: string }> = {
  10: { label: "TRACE", ansi: "\x1b[90m" },
  20: { label: "DEBUG", ansi: "\x1b[36m" },
  30: { label: "INFO", ansi: "\x1b[32m" },
  40: { label: "WARN", ansi: "\x1b[33m" },
  50: { label: "ERROR", ansi: "\x1b[31m" },
  60: { label: "FATAL", ansi: "\x1b[35m" },
};

const pad = (n: number, len = 2): string => String(n).padStart(len, "0");

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const renderPretty = (record: Record<string, unknown>, color: boolean): string => {
  const meta = LEVEL_META[record.level as number];
  const label = (meta?.label ?? "LOG").padEnd(5);
  const msg = typeof record.msg === "string" ? record.msg : "";
  const head = `${formatTime(record.time as number)} ${color ? `${meta?.ansi ?? ""}${label}${RESET}` : label}${msg ? ` ${msg}` : ""}`;

  const extra = { ...record };
  delete extra.level;
  delete extra.time;
  delete extra.msg;
  delete extra.pid;
  delete extra.hostname;
  const keys = Object.keys(extra);
  if (keys.length === 0) return head;

  let body = "";
  try {
    body = JSON.stringify(extra, null, 2);
  } catch {
    body = String(extra);
  }
  return color ? `${head}\n${DIM}${body}${RESET}` : `${head}\n${body}`;
};

/** pino destination that re-renders each JSON line as human-readable text. */
const prettyWriter = (color: boolean): { write(msg: string): boolean } => ({
  write(msg: string): boolean {
    const line = String(msg).trimEnd();
    if (line) {
      let out: string;
      try {
        out = renderPretty(JSON.parse(line) as Record<string, unknown>, color);
      } catch {
        out = line;
      }
      process.stdout.write(`${out}\n`);
    }
    return true;
  },
});

/* ── arg shaping: string / JSON / Error / variadic ───────────────────────── */

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/** Render a non-field value as text (numbers, arrays, dates, symbols, …). */
const formatScalar = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "function") return value.name ? `[fn ${value.name}]` : "[fn]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

interface SplitArgs {
  /** Structured fields (plain objects merged; `Error`s under `err`). */
  fields?: Record<string, unknown>;
  /** Human-readable message text from the remaining scalar args. */
  msg?: string;
}

/**
 * Shape a variadic argument list into pino-friendly fields + message:
 * plain objects merge into structured fields (later keys win), `Error`s are
 * attached under `err`, and every other value is joined into the message.
 */
const splitLogArgs = (args: readonly unknown[]): SplitArgs => {
  let fields: Record<string, unknown> | undefined;
  const parts: string[] = [];

  for (const arg of args) {
    if (arg instanceof Error) {
      fields ??= {};
      fields[ERR_KEY] = { name: arg.name, message: arg.message, stack: arg.stack };
    } else if (isPlainObject(arg)) {
      fields ??= {};
      Object.assign(fields, arg);
    } else {
      parts.push(formatScalar(arg));
    }
  }

  const msg = parts.length > 0 ? parts.join(" ") : undefined;
  if (fields) return msg === undefined ? { fields } : { fields, msg };
  return msg === undefined ? {} : { msg };
};

/** Emit one leveled line through the underlying pino logger. */
const emit = (logger: PinoLogger, level: LogLevel, args: readonly unknown[]): void => {
  const { fields, msg } = splitLogArgs(args);
  if (fields) logger[level](fields, msg ?? "");
  else logger[level](msg ?? "");
};

/**
 * Create the app-facing logger facade.
 *
 * ```ts
 * import { createAppLogger } from "@ignex/core";
 * const log = createAppLogger({ pretty: true });
 *
 * log.info("order created", { orderId, total }); // variadic, mixed types
 * log.warn("cache miss", route);
 * log.error(new Error("boom"), "payment failed");
 * const scoped = log.child({ requestId });       // per-request bindings
 * ```
 *
 * @param options - Level, pretty/color toggles, static base fields, extra
 * redaction paths, or an injected pino logger.
 * @returns An {@link AppLogger} facade.
 */
export const createAppLogger = (options: AppLoggerOptions = {}): AppLogger => {
  const pretty =
    options.logger === undefined && (options.pretty ?? process.env.NODE_ENV !== "production");
  const color = options.color ?? process.stdout.isTTY === true;

  const pinoOptions = {
    level: resolveLevel(options.level),
    base: options.base ?? null,
    redact: [...REDACT_PATHS, ...(options.redact ?? [])],
  };

  const underlying: PinoLogger =
    options.logger ?? (pretty ? pino(pinoOptions, prettyWriter(color)) : pino(pinoOptions));

  const make = (logger: PinoLogger): AppLogger => ({
    get level(): string {
      return logger.level;
    },
    debug(...args: unknown[]): void {
      emit(logger, "debug", args);
    },
    info(...args: unknown[]): void {
      emit(logger, "info", args);
    },
    warn(...args: unknown[]): void {
      emit(logger, "warn", args);
    },
    error(...args: unknown[]): void {
      emit(logger, "error", args);
    },
    child(bindings: Record<string, unknown>): AppLogger {
      return make(logger.child(bindings));
    },
    setLevel(level: string): void {
      logger.level = level;
    },
  });

  return make(underlying);
};

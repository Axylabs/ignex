/**
 * @fileoverview Logger plugin.
 *
 * Hardened:
 * - redacts sensitive headers
 * - exactOptionalPropertyTypes-safe pino options
 */
import pino, { type Logger as PinoLogger } from "pino";
import type { IgnexContext } from "../http/context";
import type { IgnexPlugin } from "../lifecycle/plugin";

/** Options for {@link logger}. */
export interface LoggerOptions {
  /** Minimum level to emit. Defaults to `LOG_LEVEL`, then `"info"`. */
  level?: string;
  /** Inject an existing pino logger instead of creating one. */
  logger?: PinoLogger;
  /** Skip access-log emission for a request (returning `true` silences it). */
  skip?: (ctx: IgnexContext) => boolean;
}

/** Options for {@link createLogger}. */
export interface CreateLoggerOptions {
  /**
   * Minimum level to emit. Defaults to `process.env.LOG_LEVEL`, then
   * `"info"`.
   */
  level?: string;
}

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
] as const;

/** Resolve the effective level: explicit option → `LOG_LEVEL` → `"info"`. */
const resolveLevel = (level: string | undefined): string =>
  level ?? process.env.LOG_LEVEL ?? "info";

/**
 * Create a standalone pino logger with ignex's hardened defaults: no `base`
 * line and sensitive-header redaction.
 *
 * Shared factory behind both the `logger()` access-log plugin and the global
 * app logger scaffolded at `src/lib/logger.ts`, so every line honors the same
 * level and redaction rules.
 *
 * @param options - Minimum level (`LOG_LEVEL` env is the default).
 * @returns A configured pino logger.
 */
export const createLogger = (options: CreateLoggerOptions = {}): PinoLogger =>
  pino({
    level: resolveLevel(options.level),
    base: null,
    redact: [...REDACT_PATHS],
  });

/**
 * The plugin's pino instance: an injected logger wins, otherwise one is
 * created from {@link createLogger} (only passing `level` when defined —
 * `exactOptionalPropertyTypes`).
 */
const createPinoLogger = (options: LoggerOptions): PinoLogger => {
  if (options.logger) return options.logger;
  return options.level === undefined ? createLogger() : createLogger({ level: options.level });
};

/**
 * Build structured access-log payload.
 */
const createLogPayload = (ctx: IgnexContext, response: Response) => {
  const duration = performance.now() - ctx.startTime;

  return {
    // Prefer the middleware-assigned id (inbound x-request-id or generated) so
    // access logs correlate with the echoed response header; fall back to the
    // context's lazy id when no request-id middleware is registered.
    requestId: ctx.getState<string>("requestId") ?? ctx.requestId,
    method: ctx.method,
    path: ctx.path,
    route: ctx.route ? String(ctx.route) : undefined,
    status: response.status,
    durationMs: Math.round(duration * 1000) / 1000,
    ip: ctx.ip,
    timestamp: new Date().toISOString(),
  };
};

/**
 * Structured access-log plugin (pino). Redacts authorization/cookie headers.
 *
 * @param options - Log level, custom logger, or a `skip` predicate.
 * @returns The logger plugin.
 */
export const logger = (options: LoggerOptions = {}): IgnexPlugin => {
  const log = createPinoLogger(options);

  return {
    name: "logger",

    onResponse(ctx, response) {
      if (options.skip?.(ctx)) return response;

      const payload = createLogPayload(ctx, response);

      if (response.status >= 500) {
        log.error(payload);
      } else if (response.status >= 400) {
        log.warn(payload);
      } else {
        log.info(payload);
      }

      return response;
    },
  };
};

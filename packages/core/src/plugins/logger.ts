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
  level?: string;
  logger?: PinoLogger;
  skip?: (ctx: IgnexContext) => boolean;
}

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
] as const;

/**
 * Create a pino logger with safe defaults.
 */
const createPinoLogger = (options: LoggerOptions): PinoLogger => {
  if (options.logger) return options.logger;

  return pino({
    level: options.level ?? "info",
    base: null,
    redact: [...REDACT_PATHS],
  });
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

/**
 * @fileoverview Logger plugin.
 *
 * Hardened:
 * - redacts sensitive headers
 * - exactOptionalPropertyTypes-safe pino options
 */
import pino, { type Logger as PinoLogger } from "pino";
import type { IgnusContext } from "../http/context";
import type { IgnusPlugin } from "../lifecycle/plugin";

export interface LoggerOptions {
  level?: string;
  logger?: PinoLogger;
  skip?: (ctx: IgnusContext) => boolean;
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
const createLogPayload = (ctx: IgnusContext, response: Response) => {
  const duration = performance.now() - ctx.startTime;

  return {
    requestId: ctx.requestId,
    method: ctx.method,
    path: ctx.path,
    status: response.status,
    durationMs: Math.round(duration * 1000) / 1000,
    timestamp: new Date().toISOString(),
  };
};

export const logger = (options: LoggerOptions = {}): IgnusPlugin => {
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

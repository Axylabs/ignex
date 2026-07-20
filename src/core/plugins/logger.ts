/**
 * @fileoverview Logger Plugin — pino-based structured logging.
 */

import pino, { type Logger as PinoLogger } from "pino";
import type { FluxPlugin } from "../plugin";
import type { FluxContext } from "../context";

export interface LoggerOptions {
  level?: string;
  logger?: PinoLogger;
  skip?: (ctx: FluxContext) => boolean;
}

export const logger = (options: LoggerOptions = {}): FluxPlugin => {
  const log =
    options.logger ??
    pino({
      level: options.level ?? "info",
      base: undefined,
    });

  return {
    name: "logger",

    onResponse(ctx, response) {
      if (options.skip?.(ctx)) return response;

      const duration = performance.now() - ctx.startTime;

      const payload = {
        requestId: ctx.requestId,
        method: ctx.method,
        path: ctx.path,
        status: response.status,
        durationMs: Math.round(duration * 1000) / 1000,
        timestamp: new Date().toISOString(),
      };

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
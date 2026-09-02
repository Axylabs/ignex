/** Template for the `logger` feature's global app logger (`src/lib/logger.ts`). */

export function loggerLibTemplate(): string {
  return `import { createAppLogger } from "@ignex/core";
import { env } from "../config/env.js";

/**
 * Global developer-friendly logger — import it from any route, hook, model
 * or service:
 *
 *   import { log } from "../lib/logger.js";
 *   log.info("order created", { orderId, total });   // string + JSON fields
 *   log.debug("cached", cacheKey);                   // scalars
 *   log.warn("slow query", { ms: 412 });
 *   log.error(new Error("boom"), "payment failed");  // errors
 *
 * Any mix of values is accepted per call — strings, numbers, plain objects
 * (JSON), arrays and Errors. In development output is pretty, ANSI-colored
 * text; in production it is compact pino JSON (log pipelines parse as-is).
 *
 * Extend it: pass createAppLogger() options (pretty / color / base / redact,
 * or inject your own pino logger), or scope lines with log.child({ requestId }).
 * Level comes from the validated LOG_LEVEL env (debug | info | warn | error).
 *
 * Tree-shaking: plain ES modules — when nothing imports log, the compiler's
 * bundler drops it from the compiled server. Nothing to configure.
 */
export const log = createAppLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV !== "production",
});
`;
}

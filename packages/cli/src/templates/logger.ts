/** Template for the `logger` feature's global app logger (`src/lib/logger.ts`). */

export function loggerLibTemplate(): string {
  return `import { createLogger } from "@ignex/core";
import { env } from "../config/env.js";

/**
 * Global structured logger — import it from any route, hook, model or
 * service:
 *
 *   import { log } from "../lib/logger.js";
 *   log.info("order created", { orderId, total });
 *   log.warn("slow query", { ms: 412 });
 *   log.error(err, "payment failed");
 *
 * Built by the same \`createLogger()\` factory as the \`logger()\` access-log
 * plugin (hardened defaults: no \`base\` line, sensitive-header redaction).
 * Level comes from the validated \`LOG_LEVEL\` in \`src/config/env.ts\`
 * (default "info") — debug | info | warn | error.
 *
 * Tree-shaking: plain ES modules — when nothing imports \`log\`, the
 * compiler's bundler drops it from the compiled server. Nothing to configure.
 */
export const log = createLogger({ level: env.LOG_LEVEL });
`;
}

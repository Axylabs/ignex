import { mapMongoDriverError } from "../errors/index.ts";
import type { LoggerLike } from "../utils/logger.ts";

/** Structured metadata attached to every logged DB operation. */
export interface DbOpMeta {
  collection: string;
  physicalCollection?: string;
  db: string;
  op: string;
}

export interface TraceDbOpOptions {
  /** Map driver errors to typed DomainError/InfraError before rethrowing. */
  wrapMongoErrors?: boolean;
}

/**
 * Wrap a DB operation with start/ok/error structured logging (duration, op,
 * collection, db). When `wrapMongoErrors` is set, driver errors are mapped to
 * the ORM's typed error classes before being rethrown.
 */
export const traceDbOp = async <T>(
  logger: LoggerLike,
  meta: DbOpMeta,
  fn: () => T | Promise<T>,
  options: TraceDbOpOptions = {},
): Promise<T> => {
  const start = performance.now();
  logger.debug({ ...meta, operation: "start" }, "start");
  try {
    const result = await fn();
    const durationMs = performance.now() - start;
    logger.info({ ...meta, durationMs }, "ok");
    return result;
  } catch (err) {
    const durationMs = performance.now() - start;
    const loggable =
      err instanceof Error
        ? { name: err.name, message: err.message, code: (err as { code?: unknown }).code }
        : err;
    logger.error({ ...meta, durationMs, error: loggable }, "error");
    if (options.wrapMongoErrors) throw mapMongoDriverError(err, meta);
    throw err;
  }
};

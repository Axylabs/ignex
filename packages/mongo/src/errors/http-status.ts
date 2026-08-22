/**
 * Framework-facing error helpers: `httpStatusForError` (effective HTTP status
 * for any thrown value) and `serializeError` (reduce any thrown value to a
 * stable, client-safe payload).
 */
import { AppError, type ErrorContext } from "./classes.ts";
import { mapMongoDriverError } from "./driver-map.ts";
import { isMongoTransientError } from "./transient.ts";

/** Effective HTTP status for any thrown value: AppError-aware, raw → 500 (503 transient). */
export const httpStatusForError = (err: unknown): number => {
  if (err instanceof AppError) return err.statusCode;
  if (isMongoTransientError(err)) return 503;
  return 500;
};

/**
 * Reduce any thrown value to a stable, client-safe error payload:
 * `{ name, code, message, statusCode, ...(extra) }`.
 *
 * Raw driver errors are mapped through `mapMongoDriverError` first, so a
 * framework can forward the result directly without parsing Mongo server
 * internals (`errInfo`, `writeErrors`, `keyPattern`, ...):
 *
 *   app.use((err, _req, res, _next) => {
 *     const payload = serializeError(err, { db, collection, op });
 *     res.status(payload.statusCode).json(payload);
 *   });
 */
export const serializeError = (err: unknown, ctx: ErrorContext = {}): Record<string, unknown> => {
  const mapped = mapMongoDriverError(err, ctx);
  if (mapped instanceof AppError) return mapped.toJSON();
  if (mapped instanceof Error) {
    return { name: mapped.name, code: "UNKNOWN", message: mapped.message, statusCode: 500 };
  }
  return { name: "UnknownError", code: "UNKNOWN", message: String(mapped), statusCode: 500 };
};

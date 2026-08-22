/**
 * Error taxonomy for the ORM — a self-contained replacement for the sdk-core
 * error classes the reference delegates to:
 *
 *   DomainError  → expected business violations (NOT_FOUND, DUPLICATE_KEY, ...)
 *   InfraError   → infrastructure failures (timeouts, query errors, ...)
 *   BadRequest   → malformed input from the caller
 *
 * plus driver-error mapping (`mapMongoDriverError`) and transient-error
 * detection used by the retry wrapper.
 *
 * Layout: `./classes.ts` (error classes + ERROR_HTTP_STATUS), `./transient.ts`
 * (retryable-error detection), `./driver-map.ts` (raw driver → typed errors),
 * `./http-status.ts` (framework-facing `httpStatusForError` / `serializeError`).
 */
export type { ErrorContext } from "./classes.ts";
export {
  AppError,
  BadRequest,
  DomainError,
  ERROR_HTTP_STATUS,
  InfraError,
  isAppError,
  isDomainError,
  isInfraError,
} from "./classes.ts";
export { extractValidationPaths, isMappedMongoError, mapMongoDriverError } from "./driver-map.ts";
export { httpStatusForError, serializeError } from "./http-status.ts";
export {
  isMongoDuplicateKeyError,
  isMongoTransientError,
  TRANSIENT_MONGO_ERROR_CODES,
} from "./transient.ts";

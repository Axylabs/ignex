/**
 * The ORM's error classes (`AppError` → `DomainError` / `InfraError` /
 * `BadRequest`), their type guards, and the `ERROR_HTTP_STATUS` table that sets
 * each error's `statusCode` at construction.
 *
 * A leaf module: nothing else in `src/errors/` imports this (so `driver-map.ts`
 * and `http-status.ts` can depend on it without cycles).
 */
export interface ErrorContext {
  db?: string;
  collection?: string;
  op?: string;
}

/**
 * Canonical HTTP status for each error code. `AppError.statusCode` is set from
 * this table at construction (falling back to the class default: 400 for
 * `DomainError`, 500 for `InfraError`), so a framework can respond with
 * `err.statusCode` directly and still get correct REST semantics:
 *   NOT_FOUND → 404, DUPLICATE_KEY/VERSION_CONFLICT/COLLECTION_EXISTS → 409,
 *   VALIDATION_FAILED → 422, MONGO_TIMEOUT → 504.
 */
export const ERROR_HTTP_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  DUPLICATE_KEY: 409,
  VERSION_CONFLICT: 409,
  COLLECTION_EXISTS: 409,
  SCHEMA_DRIFT: 409,
  VALIDATION_FAILED: 422,
  MONGO_TIMEOUT: 504,
};

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly extra?: Record<string, unknown>;

  constructor(code: string, message: string, statusCode = 500, extra?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    if (extra !== undefined) this.extra = extra;
  }

  /**
   * Stable, client-safe serialization for framework error middleware: a
   * framework can forward `JSON.stringify(error)` (or `error.toJSON()`) straight
   * to the client — no parsing of server internals. `stack` is dropped; the
   * shape is always `{ name, code, message, statusCode, ...(extra) }`.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      ...(this.extra !== undefined ? { extra: this.extra } : {}),
    };
  }
}

export class DomainError extends AppError {
  constructor(code: string, message: string, extra?: Record<string, unknown>) {
    super(code, message, ERROR_HTTP_STATUS[code] ?? 400, extra);
    this.name = "DomainError";
  }
}

export class InfraError extends AppError {
  constructor(code: string, message: string, extra?: Record<string, unknown>) {
    super(code, message, ERROR_HTTP_STATUS[code] ?? 500, extra);
    this.name = "InfraError";
  }
}

export class BadRequest extends DomainError {
  constructor(message: string, extra?: Record<string, unknown>) {
    super("BAD_REQUEST", message, extra);
    this.name = "BadRequest";
  }
}

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;

export const isDomainError = (err: unknown): err is DomainError => err instanceof DomainError;

export const isInfraError = (err: unknown): err is InfraError => err instanceof InfraError;

/**
 * Raw driver-error mapping: turn Mongo driver errors (codes 11000, 112, 50,
 * 121, bulk-write, transient) into the ORM's typed `DomainError` / `InfraError`,
 * plus `extractValidationPaths` for surfacing which `$jsonSchema` fields failed.
 */
import { AppError, DomainError, type ErrorContext, InfraError } from "./classes.ts";
import { isMongoDuplicateKeyError, isMongoTransientError } from "./transient.ts";

/** Shape of a single `writeErrors[]` entry on a `MongoBulkWriteError`. */
interface WriteErrorLike {
  code?: number;
  errmsg?: string;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
  errInfo?: unknown;
}

/** Shape of the `errInfo` MongoDB attaches to a `$jsonSchema` validation failure (code 121). */
interface MongoErrInfo {
  failingDocumentId?: unknown;
  details?: {
    schemaRulesNotSatisfied?: Array<{
      propertyName?: string;
      propertiesNotSatisfied?: Array<{ propertyName?: string }>;
      /** Unknown-key violations are reported as a list here (not propertiesNotSatisfied). */
      additionalProperties?: string[];
    }>;
  };
}

/**
 * Flatten the offending field paths from a `$jsonSchema` validation error so a
 * `VALIDATION_FAILED` error can name exactly which fields were rejected.
 * Covers missing/type-mismatched properties (`propertiesNotSatisfied`) and
 * unknown-key violations (`additionalProperties`).
 */
export const extractValidationPaths = (errInfo: unknown): string[] => {
  if (!errInfo || typeof errInfo !== "object") return [];
  const info = errInfo as MongoErrInfo;
  const out: string[] = [];
  for (const rule of info.details?.schemaRulesNotSatisfied ?? []) {
    if (typeof rule.propertyName === "string") out.push(rule.propertyName);
    for (const prop of rule.propertiesNotSatisfied ?? []) {
      if (typeof prop.propertyName === "string") out.push(prop.propertyName);
    }
    for (const prop of rule.additionalProperties ?? []) {
      if (typeof prop === "string") out.push(prop);
    }
  }
  return [...new Set(out)];
};

/** Enrich a mapped-error context with the failing document id + offending field paths. */
const addValidationContext = (context: Record<string, unknown>, errInfo: unknown): void => {
  if (!errInfo || typeof errInfo !== "object") return;
  const info = errInfo as MongoErrInfo;
  if (info.failingDocumentId !== undefined) context.documentId = info.failingDocumentId;
  const fields = extractValidationPaths(errInfo);
  if (fields.length > 0) context.fields = fields;
  if (info.details !== undefined) context.details = info.details;
};

const isBulkWriteError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "writeErrors" in (error as { writeErrors?: unknown }) &&
  Array.isArray((error as { writeErrors?: unknown[] }).writeErrors);

/**
 * Map a raw driver error to a typed DomainError/InfraError. Mirrors the sdk-db
 * mapping table (codes 11000 → DUPLICATE_KEY, 112 → VERSION_CONFLICT,
 * 50 → MONGO_TIMEOUT, 121 → VALIDATION_FAILED, everything else → MONGO_QUERY_ERROR).
 * When the error is already an AppError it is returned unchanged.
 */
export const mapMongoDriverError = (error: unknown, ctx: ErrorContext = {}): unknown => {
  if (error instanceof AppError) return error;

  const context: Record<string, unknown> = { ...(ctx as Record<string, unknown>) };
  if (isMongoDuplicateKeyError(error)) {
    const e = error as { keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
    if (e.keyPattern) context.keyPattern = e.keyPattern;
    if (e.keyValue) context.keyValue = e.keyValue;
    return new DomainError("DUPLICATE_KEY", "Duplicate key error", context);
  }

  if (isBulkWriteError(error)) {
    const first = (error as { writeErrors: WriteErrorLike[] }).writeErrors[0];
    if (first?.code === 11000) {
      if (first.keyPattern) context.keyPattern = first.keyPattern;
      if (first.keyValue) context.keyValue = first.keyValue;
      return new DomainError("DUPLICATE_KEY", first.errmsg ?? "Duplicate key error", context);
    }
    if (first?.code === 121) {
      addValidationContext(context, first.errInfo);
      return new DomainError("VALIDATION_FAILED", "Document failed schema validation", context);
    }
    return new InfraError("MONGO_QUERY_ERROR", "Bulk write failed", context);
  }

  const code = (error as { code?: unknown }).code;
  switch (code) {
    case 112:
      return new DomainError("VERSION_CONFLICT", "Document version conflict", context);
    case 50:
      return new InfraError("MONGO_TIMEOUT", "MongoDB operation timed out", context);
    case 121: {
      addValidationContext(context, (error as { errInfo?: unknown }).errInfo);
      return new DomainError("VALIDATION_FAILED", "Document failed schema validation", context);
    }
    default:
      break;
  }

  if (isMongoTransientError(error)) {
    const e = error as { message?: string };
    return new InfraError("MONGO_QUERY_ERROR", e.message ?? "Transient MongoDB error", context);
  }

  const msg = (error as { message?: string }).message ?? "MongoDB query error";
  return new InfraError("MONGO_QUERY_ERROR", msg, context);
};

/** True when the error is already a mapped AppError (used by callers that opted into wrapping). */
export const isMappedMongoError = (error: unknown): error is AppError => error instanceof AppError;

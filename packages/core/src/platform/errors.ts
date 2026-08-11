/**
 * @fileoverview Structured Error Types v3.0
 * Serializable, traceable, production-safe.
 */

export class HTTPError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HTTPError";
  }

  toJSON() {
    return {
      error: this.message,
      status: this.status,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  toResponse(headers?: Record<string, string>): Response {
    // Body is memoized by `status|code|message` so repeated error envelopes
    // (the common case) skip JSON.stringify + object allocation entirely.
    // When `details` is present the body is unique — build it fresh.
    const body =
      this.details === undefined
        ? cachedErrorBody(this.status, this.code, this.message)
        : JSON.stringify(this.toJSON());
    return new Response(body, {
      status: this.status,
      headers:
        headers === undefined ? JSON_HEADERS : { "content-type": "application/json", ...headers },
    });
  }
}

export class ValidationError extends HTTPError {
  constructor(
    message: string,
    public readonly errors: Record<string, string[]>,
    public readonly on?: string,
  ) {
    super(422, message, "VALIDATION_ERROR", { errors, on });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends HTTPError {
  constructor(resource?: string) {
    super(404, resource ? `${resource} not found` : "Not Found", "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends HTTPError {
  constructor(message = "Unauthorized") {
    super(401, message, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends HTTPError {
  constructor(message = "Forbidden") {
    super(403, message, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends HTTPError {
  constructor(message = "Conflict") {
    super(409, message, "CONFLICT");
    this.name = "ConflictError";
  }
}

export class BadRequestError extends HTTPError {
  constructor(message = "Bad Request") {
    super(400, message, "BAD_REQUEST");
    this.name = "BadRequestError";
  }
}

export class MethodNotAllowedError extends HTTPError {
  constructor(
    message = "Method Not Allowed",
    public readonly allow?: string,
  ) {
    super(405, message, "METHOD_NOT_ALLOWED");
    this.name = "MethodNotAllowedError";
  }
}

/** Narrowing guard for the whole HTTP error family. */
export const isHttpError = (value: unknown): value is HTTPError => value instanceof HTTPError;

export class TooManyRequestsError extends HTTPError {
  constructor(
    message = "Too Many Requests",
    public readonly retryAfter?: number,
  ) {
    super(429, message, "TOO_MANY_REQUESTS");
    this.name = "TooManyRequestsError";
  }
}

export class InternalError extends HTTPError {
  constructor(message = "Internal Server Error") {
    super(500, message, "INTERNAL_ERROR");
    this.name = "InternalError";
  }
}

export class ParseError extends HTTPError {
  constructor(cause?: Error) {
    super(400, "Bad Request", "PARSE_ERROR");
    this.name = "ParseError";
    if (cause) this.cause = cause;
  }
}

export class InvalidCookieSignature extends HTTPError {
  constructor(public readonly key: string) {
    super(400, `"${key}" has invalid cookie signature`, "INVALID_COOKIE_SIGNATURE");
    this.name = "InvalidCookieSignature";
  }
}

// ============================================================================
// Error → Response Mapping
// ============================================================================

/** Shared JSON content-type header for error envelopes (no per-call alloc). */
const JSON_HEADERS = { "content-type": "application/json" };

/** Deterministic body for the generic internal error (no detail leak). */
const INTERNAL_ERROR_BODY = JSON.stringify({
  error: "Internal Server Error",
  status: 500,
  code: "INTERNAL_ERROR",
});

/** Memoized error-envelope JSON bodies keyed by `status|code|message`. */
const bodyCache = new Map<string, string>();
const BODY_CACHE_MAX = 64;

const cachedErrorBody = (status: number, code: string | undefined, message: string): string => {
  const key = `${status}|${code ?? ""}|${message}`;
  const hit = bodyCache.get(key);
  if (hit !== undefined) return hit;
  const body = JSON.stringify({ error: message, status, code });
  if (bodyCache.size >= BODY_CACHE_MAX) {
    const first = bodyCache.keys().next().value;
    if (first !== undefined) bodyCache.delete(first);
  }
  bodyCache.set(key, body);
  return body;
};

export const errorToResponse = (err: unknown, exposeDetails = false): Response => {
  if (err instanceof HTTPError) return err.toResponse();

  const message = exposeDetails && err instanceof Error ? err.message : "Internal Server Error";

  // Hottest path: generic 500 without detail exposure — fully pre-baked.
  if (message === "Internal Server Error") {
    return new Response(INTERNAL_ERROR_BODY, { status: 500, headers: JSON_HEADERS });
  }

  return new Response(cachedErrorBody(500, "INTERNAL_ERROR", message), {
    status: 500,
    headers: JSON_HEADERS,
  });
};

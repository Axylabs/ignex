/**
 * @fileoverview Structured Error Types v3.0
 * Serializable, traceable, production-safe.
 */

/**
 * Base class for the structured HTTP error family.
 *
 * Every ignex error extends this so it carries an HTTP `status`, a machine
 * `code`, and optional `details`, serializes via {@link toJSON}, and converts
 * to a JSON `Response` via {@link toResponse}. `errorToResponse` and the
 * lifecycle `error` stage recognize it, so throwing one from a handler yields
 * the intended status instead of a 500.
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

/**
 * 422 Unprocessable Entity — field-scoped validation failures.
 *
 * `errors` maps field names to message lists; `on` optionally names the
 * resource/endpoint the failure applies to.
 */
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

/** 404 Not Found — a requested resource does not exist. */
export class NotFoundError extends HTTPError {
  constructor(resource?: string) {
    super(404, resource ? `${resource} not found` : "Not Found", "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

/** 401 Unauthorized — authentication is missing or failed. */
export class UnauthorizedError extends HTTPError {
  constructor(message = "Unauthorized") {
    super(401, message, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

/** 403 Forbidden — authenticated but not allowed to perform the action. */
export class ForbiddenError extends HTTPError {
  constructor(message = "Forbidden") {
    super(403, message, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

/** 409 Conflict — the request conflicts with the current state. */
export class ConflictError extends HTTPError {
  constructor(message = "Conflict") {
    super(409, message, "CONFLICT");
    this.name = "ConflictError";
  }
}

/** 400 Bad Request — malformed or invalid client input. */
export class BadRequestError extends HTTPError {
  constructor(message = "Bad Request") {
    super(400, message, "BAD_REQUEST");
    this.name = "BadRequestError";
  }
}

/**
 * 405 Method Not Allowed — the path exists but not for this method.
 *
 * `allow` optionally lists the permitted methods for the `Allow` header.
 */
export class MethodNotAllowedError extends HTTPError {
  constructor(
    message = "Method Not Allowed",
    public readonly allow?: string,
  ) {
    super(405, message, "METHOD_NOT_ALLOWED");
    this.name = "MethodNotAllowedError";
  }

  toResponse(headers?: Record<string, string>): Response {
    // Surface the permitted methods on the wire (`Allow`) — previously the
    // `allow` field was never emitted, so clients had no way to discover the
    // allowed methods after a 405.
    return super.toResponse(this.allow === undefined ? headers : { allow: this.allow, ...headers });
  }
}

/** Narrowing guard for the whole HTTP error family. */
export const isHttpError = (value: unknown): value is HTTPError => value instanceof HTTPError;

/**
 * 429 Too Many Requests — rate limit exceeded.
 *
 * `retryAfter` optionally seconds for the `Retry-After` header.
 */
export class TooManyRequestsError extends HTTPError {
  constructor(
    message = "Too Many Requests",
    public readonly retryAfter?: number,
  ) {
    super(429, message, "TOO_MANY_REQUESTS");
    this.name = "TooManyRequestsError";
  }
}

/** 500 Internal Server Error — an unhandled server-side failure. */
export class InternalError extends HTTPError {
  constructor(message = "Internal Server Error") {
    super(500, message, "INTERNAL_ERROR");
    this.name = "InternalError";
  }
}

/**
 * 400 Bad Request — the request body/input failed to parse.
 *
 * The original thrown error is retained as the error `cause` when provided.
 */
export class ParseError extends HTTPError {
  constructor(cause?: Error) {
    super(400, "Bad Request", "PARSE_ERROR");
    this.name = "ParseError";
    if (cause) this.cause = cause;
  }
}

/** 400 Bad Request — a cookie's signature failed verification. */
export class InvalidCookieSignature extends HTTPError {
  constructor(public readonly key: string) {
    super(400, `"${key}" has invalid cookie signature`, "INVALID_COOKIE_SIGNATURE");
    this.name = "InvalidCookieSignature";
  }
}

// ============================================================================
// Error → Response Mapping
// ============================================================================

/**
 * Shared JSON content-type header for error envelopes (no per-call alloc).
 *
 * Error envelopes always carry the core security posture (frame protection,
 * no-sniff, referrer policy) so they match the OK-path `security()` plugin and
 * the Rust ingress pipeline's pre-baked terminal templates — error pages are
 * never frameable or MIME-sniffable even if an app disables the header plugin.
 */
const JSON_HEADERS: Record<string, string> = Object.freeze({
  "content-type": "application/json",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

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

/**
 * Convert any thrown value into an error `Response`.
 *
 * `HTTPError` instances map to their own status/code/body. Everything else
 * becomes a 500: the message is only exposed when `exposeDetails` is true
 * (otherwise a generic "Internal Server Error" envelope prevents detail leak).
 *
 * @param err - The thrown value.
 * @param exposeDetails - When true, leak `Error.message` on non-HTTP errors.
 * @returns A JSON `Response` with security headers pre-applied.
 */
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

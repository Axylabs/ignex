/**
 * @fileoverview Structured Error Types v3.0
 * Serializable, traceable, production-safe.
 */

export class HTTPError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>
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
    return Response.json(this.toJSON(), {
      status: this.status,
      headers: { "content-type": "application/json", ...headers },
    });
  }
}

export class ValidationError extends HTTPError {
  constructor(
    message: string,
    public readonly errors: Record<string, string[]>,
    public readonly on?: string
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

export class TooManyRequestsError extends HTTPError {
  constructor(message = "Too Many Requests", public readonly retryAfter?: number) {
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

export const errorToResponse = (err: unknown, exposeDetails = false): Response => {
  if (err instanceof HTTPError) return err.toResponse();

  const message = exposeDetails && err instanceof Error ? err.message : "Internal Server Error";
  return Response.json(
    { error: message, status: 500, code: "INTERNAL_ERROR" },
    { status: 500 }
  );
};

// ============================================================================
// Status Map (Type-safe status codes)
// ============================================================================

export const StatusMap = {
  Continue: 100, "Switching Protocols": 101, Processing: 102,
  OK: 200, Created: 201, Accepted: 202, "No Content": 204, "Partial Content": 206,
  "Multiple Choices": 300, "Moved Permanently": 301, Found: 302, "Not Modified": 304,
  "Bad Request": 400, Unauthorized: 401, Forbidden: 403, "Not Found": 404,
  "Method Not Allowed": 405, Conflict: 409, Gone: 410, "Too Many Requests": 429,
  "Internal Server Error": 500, "Bad Gateway": 502, "Service Unavailable": 503,
} as const;

export type StatusMapKey = keyof typeof StatusMap;
/**
 * @fileoverview The HTTP error family — typed errors that carry a status, a
 * stable code and the fault taxonomy, and serialize to a client envelope.
 *
 * ```
 * AppError                       (platform/app-error.ts — taxonomy root)
 * └── HTTPError                  status + toResponse/toJSON
 *     ├── RequestError           4xx: the caller's fault (origin "request")
 *     │   ├── BadRequestError / ValidationError / ParseError / BodyParseError
 *     │   ├── NotFoundError / ConflictError / MethodNotAllowedError
 *     │   ├── TooManyRequestsError / UnsafeRedirectError
 *     │   ├── UnauthorizedError / ForbiddenError / InvalidCookieSignature (origin "auth")
 *     └── InternalError          500: unexpected internal state (origin "internal")
 * ```
 *
 * The 5xx classes that declare a different origin — `DBError` (503, `db`),
 * `ConfigError` (500, `config`), `UpstreamError` (502, `network`),
 * `DependencyError` (500, `dependency`) — live in `operational-errors.ts`.
 *
 * The origin is what makes a failure traceable: an error that declares
 * `origin: "db"` answers "which part broke down" structurally, where a bare
 * `Error` can only be guessed at. `originForStatus`/`kindForStatus` supply the
 * default taxonomy for a status, and a subclass's statics override it
 * (`InternalError` is 500 and origin `internal`, not `app`).
 *
 * `errorToResponse` (in `errors.ts`) is the boundary that turns any of these —
 * or any raw throw — into a response.
 */

import { AppError, type AppErrorOptions } from "./app-error";
import {
  cachedErrorBody,
  type ErrorExposureOptions,
  genericStatusMessage,
  JSON_HEADERS,
} from "./error-envelope";
import {
  type FaultKind,
  type FaultOrigin,
  kindForStatus,
  originForStatus,
} from "./fault-vocabulary";
import { redactLogText } from "./redact";

// The envelope primitives live in `error-envelope.ts` (headers, memoized bodies,
// canonical reason phrases); re-exported here because this module is the public
// entry point for the HTTP error family.
export {
  cachedErrorBody,
  type ErrorExposureOptions,
  genericStatusMessage,
  JSON_HEADERS,
} from "./error-envelope";

/**
 * Extra taxonomy an HTTP error subclass may declare on top of the status-derived
 * default (`DBError` is 503 but origin `db`, not `internal`).
 *
 * `hint`, `detail` and `cause` are operator-only: they reach the fault report,
 * never the response envelope. `expose` overrides the status-derived visibility
 * of `message`/`details`.
 */
export interface HttpErrorTaxonomy {
  origin?: FaultOrigin;
  kind?: FaultKind;
  retryable?: boolean;
  expose?: boolean;
  hint?: string;
  detail?: string;
  cause?: unknown;
}

/**
 * Base class for the structured HTTP error family.
 *
 * Every ignex HTTP error extends this so it carries a `status`, a machine
 * `code`, the fault taxonomy ({@link AppError.origin}), and optional `details`,
 * serializes via {@link toJSON}, and converts to a JSON `Response` via
 * {@link toResponse}. `errorToResponse` and the lifecycle `error` stage
 * recognize it, so throwing one from a handler yields the intended status
 * instead of a 500.
 *
 * The positional signature is the long-standing public one; the taxonomy comes
 * from the class's statics (`static origin = "db"`) or, failing that, from the
 * status itself (`401` → origin `auth`, other 4xx → `request`, 5xx →
 * `internal`).
 *
 * **Exposure policy.** A 4xx message is the client contract, so it is sent. A
 * 5xx message is operator detail (it may quote a driver, a host or a query), so
 * it is NOT: the envelope carries the canonical status text
 * ({@link genericStatusMessage}) plus the machine `code`, the report carries the
 * detail, and `exposeErrors` (on outside production) reveals the redacted
 * message to a developer. Pass `expose: true` per error to override.
 */
export class HTTPError extends AppError {
  /** The HTTP status this error answers with. */
  readonly status: number;

  constructor(
    status: number,
    message: string,
    code?: string,
    details?: Record<string, unknown>,
    taxonomy?: HttpErrorTaxonomy,
  ) {
    const klass = new.target as typeof HTTPError;
    super({
      message,
      ...(code === undefined ? {} : { code }),
      ...(details === undefined ? {} : { details }),
      origin: taxonomy?.origin ?? klass.origin ?? originForStatus(status),
      kind: taxonomy?.kind ?? klass.kind ?? kindForStatus(status),
      // Fail closed on 5xx: only 4xx (and explicit opt-ins) reach a client.
      expose: taxonomy?.expose ?? status < 500,
      ...(taxonomy?.retryable === undefined ? {} : { retryable: taxonomy.retryable }),
      ...(taxonomy?.hint === undefined ? {} : { hint: taxonomy.hint }),
      ...(taxonomy?.detail === undefined ? {} : { detail: taxonomy.detail }),
      ...(taxonomy?.cause === undefined ? {} : { cause: taxonomy.cause }),
    });
    this.status = status;
  }

  /**
   * The client-safe envelope payload.
   *
   * Safe by construction, so `JSON.stringify(err)` / `Response.json(err)` cannot
   * leak internals: a non-exposed error yields the generic status text and no
   * `details`. Operators read `message`/`detail` off the instance and from the
   * fault report.
   *
   * @param options - `expose: true` forces the real (redacted) message.
   * @returns The envelope object.
   */
  toJSON(options: ErrorExposureOptions = {}): Record<string, unknown> {
    const exposed = options.expose === true || this.expose;
    const payload: Record<string, unknown> = {
      error:
        options.expose === true
          ? redactLogText(this.message)
          : this.expose
            ? this.message
            : genericStatusMessage(this.status),
      status: this.status,
      code: this.code,
    };
    if (exposed && this.details !== undefined) payload.details = this.details;
    return payload;
  }

  toResponse(headers?: Record<string, string>, options: ErrorExposureOptions = {}): Response {
    // Body is memoized by `status|code|message` so repeated error envelopes
    // (the common case) skip JSON.stringify + object allocation entirely.
    // When `details` are present the body is unique — build it fresh.
    const exposed = options.expose === true || this.expose;
    const message = (this.toJSON(options).error ?? genericStatusMessage(this.status)) as string;
    const body =
      exposed && this.details !== undefined
        ? JSON.stringify(this.toJSON(options))
        : cachedErrorBody(this.status, this.code, message);
    return new Response(body, {
      status: this.status,
      headers:
        headers === undefined ? JSON_HEADERS : { "content-type": "application/json", ...headers },
    });
  }
}

/** Narrowing guard for the whole HTTP error family. */
export const isHttpError = (value: unknown): value is HTTPError => value instanceof HTTPError;

/**
 * The caller's fault: every 4xx error lives here.
 *
 * Status/programmatic-signature compatible with `HTTPError`
 * (`new RequestError(404, "not found", "NOT_FOUND")`), so it is the base for the
 * named 4xx classes below and for app-defined 4xx errors — one class to extend
 * for the whole client-error family.
 */
export class RequestError extends HTTPError {
  static readonly origin: FaultOrigin = "request";

  constructor(
    status = 400,
    message = "Bad Request",
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(status, message, code, details);
  }
}

/**
 * 422 Unprocessable Entity — field-scoped validation failures.
 *
 * `errors` maps field names to message lists; `on` optionally names the
 * resource/endpoint the failure applies to.
 */
export class ValidationError extends RequestError {
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
export class NotFoundError extends RequestError {
  constructor(resource?: string) {
    super(404, resource ? `${resource} not found` : "Not Found", "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

/** 401 Unauthorized — authentication is missing or failed (origin `auth`). */
export class UnauthorizedError extends RequestError {
  static readonly origin: FaultOrigin = "auth";

  constructor(message = "Unauthorized") {
    super(401, message, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

/** 403 Forbidden — authenticated but not allowed (origin `auth`). */
export class ForbiddenError extends RequestError {
  static readonly origin: FaultOrigin = "auth";

  constructor(message = "Forbidden") {
    super(403, message, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

/** 409 Conflict — the request conflicts with the current state. */
export class ConflictError extends RequestError {
  constructor(message = "Conflict") {
    super(409, message, "CONFLICT");
    this.name = "ConflictError";
  }
}

/** 400 Bad Request — malformed or invalid client input. */
export class BadRequestError extends RequestError {
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
export class MethodNotAllowedError extends RequestError {
  static readonly kind: FaultKind = "invalid";

  constructor(
    message = "Method Not Allowed",
    public readonly allow?: string,
  ) {
    super(405, message, "METHOD_NOT_ALLOWED");
    this.name = "MethodNotAllowedError";
  }

  override toResponse(headers?: Record<string, string>): Response {
    // Surface the permitted methods on the wire (`Allow`) — previously the
    // `allow` field was never emitted, so clients had no way to discover the
    // allowed methods after a 405.
    return super.toResponse(this.allow === undefined ? headers : { allow: this.allow, ...headers });
  }
}

/**
 * 429 Too Many Requests — rate limit exceeded.
 *
 * `retryAfter` optionally seconds for the `Retry-After` header.
 */
export class TooManyRequestsError extends RequestError {
  static readonly retryable = true;

  constructor(
    message = "Too Many Requests",
    public readonly retryAfter?: number,
  ) {
    super(429, message, "TOO_MANY_REQUESTS");
    this.name = "TooManyRequestsError";
  }
}

/**
 * 400 Bad Request — the request body/input failed to parse.
 *
 * The original thrown error is retained as the error `cause` when provided.
 */
export class ParseError extends RequestError {
  constructor(cause?: Error) {
    super(400, "Bad Request", "PARSE_ERROR");
    this.name = "ParseError";
    if (cause) this.cause = cause;
  }
}

/** 400 Bad Request — a cookie's signature failed verification (origin `auth`). */
export class InvalidCookieSignature extends RequestError {
  static readonly origin: FaultOrigin = "auth";

  constructor(public readonly key: string) {
    super(400, `"${key}" has invalid cookie signature`, "INVALID_COOKIE_SIGNATURE");
    this.name = "InvalidCookieSignature";
  }
}

/** Options for {@link InternalError}. */
export interface InternalErrorOptions extends Omit<AppErrorOptions, "message"> {
  /** Client-visible message. Defaults to `"Internal Server Error"`. */
  message?: string;
  /** Override the HTTP status (default 500). */
  status?: number | undefined;
}

/** 500 Internal Server Error — an unhandled server-side failure (origin `internal`). */
export class InternalError extends HTTPError {
  static readonly origin: FaultOrigin = "internal";

  constructor(message = "Internal Server Error", options: InternalErrorOptions = {}) {
    super(options.status ?? 500, message, options.code ?? "INTERNAL_ERROR", options.details, {
      origin: "internal",
      ...(options.hint === undefined ? {} : { hint: options.hint }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "InternalError";
  }
}

/**
 * 5xx classes that declare a non-`internal` origin — `DBError`, `ConfigError`,
 * `UpstreamError`, `DependencyError` — live in `operational-errors.ts`.
 */

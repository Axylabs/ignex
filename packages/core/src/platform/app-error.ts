/**
 * @fileoverview `AppError` — the root of the typed error family.
 *
 * Every typed ignex error carries the fault taxonomy, so a failure says which
 * subsystem broke and why without anyone reading a stack trace:
 *
 * - `origin` — the subsystem (`app`, `request`, `auth`, `internal`, `config`,
 *   `db`, `network`, `dependency`, `native`),
 * - `kind` — the shape of the failure (`credentials`, `unreachable`, `invalid`,
 *   …),
 * - `code` — a stable machine id (defaulting to `IGN_<ORIGIN>_<KIND>`),
 * - `retryable` — whether retrying the operation may succeed,
 * - `hint` / `detail` — operator-only text that is never sent to a client.
 *
 * The HTTP family (statuses, envelopes, `toResponse`) lives in
 * `http-errors.ts`; an application-only failure needs no status at all — the
 * response boundary derives one from the origin ({@link statusOf}). `toFault`
 * in `fault.ts` turns any throw — typed or arbitrary — into the structured
 * report the reporters render.
 */

import {
  FAULT_STATUS,
  type FaultKind,
  type FaultOrigin,
  faultCode,
  isRetryableKind,
} from "./fault-vocabulary";

/** Options for {@link AppError} and every subclass that accepts them. */
export interface AppErrorOptions {
  /**
   * Message. It reaches a client only when {@link AppError.expose} is true —
   * the 4xx family sets that from its status, and `exposeErrorDetails` (dev)
   * overrides it at the boundary. A 5xx message stays operator-only.
   */
  message: string;
  /** Stable machine code. Defaults to `IGN_<ORIGIN>_<KIND>`. */
  code?: string | undefined;
  /** Which subsystem failed. Defaults to the class's static `origin`, else `app`. */
  origin?: FaultOrigin | undefined;
  /** What kind of failure it is. Defaults to the class's static `kind`, else `unexpected`. */
  kind?: FaultKind | undefined;
  /** Whether retrying may succeed. Defaults to the class's static, else the kind's. */
  retryable?: boolean | undefined;
  /**
   * May this error's `message` (and `details`) be sent to a client? Defaults to
   * the class's static, else `false` — fail closed. The HTTP family sets it from
   * the status (`4xx` → visible, `5xx` → operator-only).
   */
  expose?: boolean | undefined;
  /** Operator guidance (reports and logs only — never sent to a client). */
  hint?: string | undefined;
  /** Operator-facing detail (reports and logs only — never sent to a client). */
  detail?: string | undefined;
  /** Structured, non-secret context. Sent only when {@link AppError.expose}. */
  details?: Record<string, unknown> | undefined;
  /** The underlying error (driver failure, fetch rejection, …). */
  cause?: unknown;
}

/**
 * Base class for every typed ignex error.
 *
 * Subclasses declare their taxonomy once as statics (`static origin = "db"`)
 * and every instance inherits it, so `origin`/`kind`/`retryable` cannot drift
 * from the class that documents them.
 */
export class AppError extends Error {
  /** Taxonomy defaults for the whole class (overridable per instance). */
  static readonly origin?: FaultOrigin;
  static readonly kind?: FaultKind;
  static readonly retryable?: boolean;
  /** Whether the class's messages are client-visible by default. */
  static readonly expose?: boolean;

  /** Which subsystem failed. */
  readonly origin: FaultOrigin;
  /** What kind of failure it is. */
  readonly kind: FaultKind;
  /** Stable machine code (`IGN_DB_CREDENTIALS`, `VALIDATION_ERROR`, …). */
  readonly code: string;
  /** Whether retrying the same operation may succeed. */
  readonly retryable: boolean;
  /**
   * Whether `message`/`details` may reach a client. Fail-closed: a bare
   * `AppError` is operator-only and the response boundary answers with the
   * generic status text instead.
   */
  readonly expose: boolean;
  /** Operator guidance — reports and logs only. */
  readonly hint?: string | undefined;
  /** Operator-facing detail — reports and logs only. */
  readonly detail?: string | undefined;
  /** Structured, non-secret context (sent only when {@link expose}). */
  readonly details?: Record<string, unknown> | undefined;

  constructor(options: AppErrorOptions) {
    super(options.message);
    // `new.target` is the class actually constructed, so a subclass's statics
    // win over this base's `undefined` defaults.
    const klass = new.target as typeof AppError;

    const origin = options.origin ?? klass.origin ?? "app";
    const kind = options.kind ?? klass.kind ?? "unexpected";
    this.name = klass.name || "AppError";
    this.origin = origin;
    this.kind = kind;
    this.code = faultCode(origin, kind, options.code);
    this.retryable = options.retryable ?? klass.retryable ?? isRetryableKind(kind);
    this.expose = options.expose ?? klass.expose ?? false;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Narrowing guard for the typed error family. */
export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

/**
 * The HTTP status to answer with: the error's own `status` when it carries one
 * (the HTTP family in `http-errors.ts` does), else the origin's canonical status
 * (`db` → 503, `network` → 502, everything else → 500).
 *
 * @param error - A typed error.
 * @returns The status a response boundary should use.
 */
export const statusOf = (error: AppError): number => {
  const declared = (error as { status?: unknown }).status;
  return typeof declared === "number" ? declared : FAULT_STATUS[error.origin];
};

/**
 * A non-HTTP application failure: the app's own logic went wrong and no status
 * other than 500 is meaningful. Prefer the specific classes in `http-errors.ts`
 * (`DBError`, `ConfigError`, `UpstreamError`, …) when they fit — the origin is
 * what makes a failure traceable.
 */
export class ApplicationError extends AppError {
  static readonly origin: FaultOrigin = "app";

  constructor(message = "Application error", options: Omit<AppErrorOptions, "message"> = {}) {
    super({ ...options, message });
  }
}

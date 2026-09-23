/**
 * @fileoverview Operational errors — the typed 5xx family for "the machinery
 * broke", each declaring its origin so a failure is traceable at a glance.
 *
 * | Class | origin | status | retryable | for |
 * |---|---|---|---|---|
 * | {@link DBError} | `db` | 503 | yes (unless the kind says otherwise) | a datastore or driver failure |
 * | {@link UpstreamError} | `network` | 502 | yes | an outbound call failed |
 * | {@link ConfigError} | `config` | 500 | no | environment/config is wrong |
 * | {@link DependencyError} | `dependency` | 500 | no | a package/addon/binary is missing |
 *
 * They extend `HTTPError`, so they answer with their own status and envelope and
 * the lifecycle `error` stage recognizes them — while `toFault` reports them
 * with the right origin/kind/hint. Operator text (`detail`, `operation`,
 * `collection`, `target`) never reaches a response body: the client sees the
 * class's generic message and the machine code.
 */

import type { AppErrorOptions } from "./app-error";
import { type FaultKind, type FaultOrigin, isRetryableKind } from "./fault-vocabulary";
import { HTTPError } from "./http-errors";

/** Options for {@link DBError}. */
export interface DBErrorOptions {
  /** Client-visible message. Defaults to `"Database unavailable"` — keep it generic. */
  message?: string;
  /** Datastore name (`MongoDB`, `PostgreSQL`). */
  service?: string;
  /** Operation that failed (`insertOne`, `aggregate`, `SELECT`, …). */
  operation?: string;
  /** Collection/table targeted. */
  collection?: string;
  /** Failure kind (`credentials`, `unreachable`, `timeout`, `query`, …). */
  kind?: FaultKind;
  /** Machine code. Defaults to `IGN_DB_ERROR`. */
  code?: string;
  /** Override the retryability verdict (default `true`). */
  retryable?: boolean;
  /** Override the HTTP status (default 503). */
  status?: number | undefined;
  /** Structured, non-secret context. */
  details?: Record<string, unknown>;
  /** The driver error. */
  cause?: unknown;
}

/**
 * A datastore/driver failure — origin `db`, 503 by default.
 *
 * The constructor takes the OPERATOR's text (the driver message, the collection,
 * the operation) separately from the client-visible message, so a driver's
 * internals never reach a response body by accident:
 *
 * ```ts
 * try {
 *   await db.insertOne(doc);
 * } catch (cause) {
 *   throw new DBError("insert into gigs failed", { operation: "insertOne", service: "MongoDB", cause });
 * }
 * ```
 *
 * Retryable by default (an unavailable datastore usually recovers) — pass
 * `retryable: false`, or a non-retryable `kind` such as `credentials`, for a
 * rejected credential or a constraint violation.
 */
export class DBError extends HTTPError {
  static readonly origin: FaultOrigin = "db";
  static readonly retryable = true;

  /** Datastore the failure came from (`MongoDB`, `PostgreSQL`, …). */
  readonly service?: string;
  /** Operation that failed. */
  readonly operation?: string;
  /** Collection/table the operation targeted. */
  readonly collection?: string;

  constructor(detail: string, options: DBErrorOptions = {}) {
    // A declared kind wins over the class's "retryable by default" stance: a
    // rejected credential or a constraint violation is not worth retrying.
    const retryable =
      options.retryable ??
      (options.kind === undefined ? DBError.retryable : isRetryableKind(options.kind));
    super(
      options.status ?? 503,
      options.message ?? "Database unavailable",
      options.code ?? "IGN_DB_ERROR",
      options.details,
      {
        origin: "db",
        kind: options.kind ?? "unexpected",
        retryable,
        detail,
        ...(options.cause === undefined ? {} : { cause: options.cause }),
      },
    );
    this.name = "DBError";
    if (options.service !== undefined) this.service = options.service;
    if (options.operation !== undefined) this.operation = options.operation;
    if (options.collection !== undefined) this.collection = options.collection;
  }
}

/** Options for {@link ConfigError}. */
export interface ConfigErrorOptions extends Omit<AppErrorOptions, "message"> {
  /** Client-visible message. Defaults to `"Invalid configuration"`. */
  message?: string;
  /** Override the HTTP status (default 500). */
  status?: number | undefined;
}

/**
 * The environment or app configuration is wrong: a missing required variable, an
 * unusable option, credentials that were never wired up — origin `config`.
 * Not retryable: something must be fixed and the app restarted.
 */
export class ConfigError extends HTTPError {
  static readonly origin: FaultOrigin = "config";
  static readonly retryable = false;

  constructor(message = "Invalid configuration", options: ConfigErrorOptions = {}) {
    super(options.status ?? 500, message, options.code ?? "IGN_CONFIG_ERROR", options.details, {
      origin: "config",
      kind: options.kind ?? "invalid",
      retryable: options.retryable ?? false,
      ...(options.hint === undefined ? {} : { hint: options.hint }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "ConfigError";
  }
}

/** Options for {@link UpstreamError}. */
export interface UpstreamErrorOptions extends Omit<AppErrorOptions, "message"> {
  /** The upstream host/URL the call targeted. */
  target?: string;
  /** Client-visible message. Defaults to `"Upstream service unavailable"`. */
  message?: string;
  /** Failure kind (default `unreachable`). */
  kind?: FaultKind;
  /** Override the HTTP status (default 502). */
  status?: number | undefined;
}

/**
 * An outbound call failed: an upstream HTTP service, a broker, a socket —
 * origin `network`, 502. Not the client's fault and not this server's own logic.
 */
export class UpstreamError extends HTTPError {
  static readonly origin: FaultOrigin = "network";
  static readonly retryable = true;

  /** The upstream host/URL the call targeted. */
  readonly target?: string;

  constructor(message = "Upstream service unavailable", options: UpstreamErrorOptions = {}) {
    const kind = options.kind ?? "unreachable";
    super(options.status ?? 502, message, options.code ?? "IGN_UPSTREAM_ERROR", options.details, {
      origin: "network",
      kind,
      retryable: options.retryable ?? isRetryableKind(kind),
      ...(options.hint === undefined ? {} : { hint: options.hint }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "UpstreamError";
    if (options.target !== undefined) this.target = options.target;
  }
}

/** Options for {@link DependencyError}. */
export interface DependencyErrorOptions extends Omit<AppErrorOptions, "message"> {
  /** The package/addon/binary that is missing. */
  dependency?: string;
  /** Client-visible message. Defaults to `"Required dependency unavailable"`. */
  message?: string;
  /** Override the HTTP status (default 500). */
  status?: number | undefined;
}

/**
 * A required dependency is missing or unusable — a package that was never
 * installed, an addon that failed to load, a binary that is not on PATH.
 */
export class DependencyError extends HTTPError {
  static readonly origin: FaultOrigin = "dependency";
  static readonly retryable = false;

  /** The package/addon/binary that is missing. */
  readonly dependency?: string;

  constructor(message = "Required dependency unavailable", options: DependencyErrorOptions = {}) {
    super(options.status ?? 500, message, options.code ?? "IGN_DEPENDENCY_ERROR", options.details, {
      origin: "dependency",
      kind: options.kind ?? "dependency",
      retryable: options.retryable ?? false,
      ...(options.hint === undefined ? {} : { hint: options.hint }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "DependencyError";
    if (options.dependency !== undefined) this.dependency = options.dependency;
  }
}

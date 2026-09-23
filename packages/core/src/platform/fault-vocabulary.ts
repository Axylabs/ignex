/**
 * @fileoverview Fault vocabulary — the types and pure mapping helpers the
 * error system is built from.
 *
 * A **fault** is the framework's structured description of a failure: which
 * subsystem broke (`origin`), what kind of failure it was (`kind`), a stable
 * machine `code`, the HTTP `status` the boundary should use, whether retrying
 * may help, operator guidance (`hints`), and a sanitized `cause` chain.
 *
 * This module is the leaf of the error system — types plus pure helpers, no
 * imports — so `app-error.ts` (the class family) and `fault.ts` (the
 * classifier/renderer) can both depend on it without a cycle.
 */

import type { EnvIssue } from "./env-diagnostics";

/** Which part of the stack a failure came from. */
export type FaultOrigin =
  /** Application or plugin code (business logic, a user hook). */
  | "app"
  /** The client's request was invalid — the caller can fix it. */
  | "request"
  /** Credentials/authorization: who the caller is, or what they may do. */
  | "auth"
  /** The framework or app hit an unexpected internal state. */
  | "internal"
  /** Configuration: environment, options, credentials wiring. */
  | "config"
  /** A datastore or its driver (MongoDB, PostgreSQL, Redis, SQLite, …). */
  | "db"
  /** A network peer: an upstream service, DNS, a socket. */
  | "network"
  /** A required module, package or addon could not be loaded. */
  | "dependency"
  /** The native (castrum) layer. */
  | "native";

/** What kind of failure it is within its {@link FaultOrigin}. */
export type FaultKind =
  /** The caller aborted (client disconnect, cancelled fetch). */
  | "aborted"
  /** Bad input/shape the caller can correct. */
  | "invalid"
  /** No usable credentials. */
  | "unauthorized"
  /** Credentials rejected by a datastore/service. */
  | "credentials"
  /** Authenticated but not permitted. */
  | "forbidden"
  /** The target does not exist. */
  | "missing"
  /** State conflict (duplicate key, version mismatch). */
  | "conflict"
  /** A quota/rate limit was hit. */
  | "limit"
  /** Host/port refused, DNS failed, socket closed. */
  | "unreachable"
  /** The operation exceeded its deadline. */
  | "timeout"
  /** A datastore rejected the operation itself (constraint, syntax, plan). */
  | "query"
  /** A dependency (package, addon, binary) is absent or unusable. */
  | "dependency"
  /** The listen port is already taken. */
  | "port"
  /** Anything not classified above. */
  | "unexpected";

/** One sanitized entry of an error's `cause` chain (no raw objects). */
export interface FaultCause {
  /** Constructor name (`MongoServerError`, `TypeError`, …). */
  readonly name: string;
  /** Redacted, single-line message. */
  readonly message: string;
  /** Driver/system code, when the cause carried one (`13`, `ECONNREFUSED`). */
  readonly code?: string;
}

/** Request facts a fault report can carry when it happened while serving. */
export interface FaultRequestInfo {
  /** Correlated request id (the one echoed in `x-request-id`). */
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  /** Matched route pattern (`/users/:id`). */
  readonly route?: string;
  readonly ip?: string;
}

/** A classified failure — the unit every error report is rendered from. */
export interface Fault {
  readonly origin: FaultOrigin;
  readonly kind: FaultKind;
  /**
   * Stable machine code. Framework errors keep the code they declared
   * (`VALIDATION_ERROR`, `IGN_ENV_VALIDATION_FAILED`); classified throws that
   * carry none get `IGN_<ORIGIN>_<KIND>` (`IGN_DB_CREDENTIALS`).
   */
  readonly code: string;
  /** HTTP status the response boundary uses for this failure. */
  readonly status: number;
  /** One-line, human summary of what went wrong. */
  readonly summary: string;
  /** The most specific message (the driver's own words), redacted + clipped. */
  readonly message: string;
  /** Operator-facing detail supplied by the throwing code (an `AppError` detail). */
  readonly detail?: string | undefined;
  /** Service the failure came from (`MongoDB`, `PostgreSQL`), when known. */
  readonly service?: string | undefined;
  /** Whether retrying the same operation may succeed. */
  readonly retryable: boolean;
  /** Operator guidance, most-likely fix first. */
  readonly hints: readonly string[];
  /** Sanitized `cause` chain (deepest last). */
  readonly causes: readonly FaultCause[];
  /** Structured env issues, when the throw carried them. */
  readonly issues: readonly EnvIssue[];
  /** Constructor name of the thrown value (`MongoServerError`, …). */
  readonly errorName: string;
  /** `file:line:column` of the first non-framework frame, when available. */
  readonly where?: string;
}

/** Every origin, in report order — used by tests and tooling. */
export const FAULT_ORIGINS: readonly FaultOrigin[] = [
  "request",
  "auth",
  "app",
  "internal",
  "config",
  "db",
  "network",
  "dependency",
  "native",
];

/** Every kind, in report order — used by tests and tooling. */
export const FAULT_KINDS: readonly FaultKind[] = [
  "invalid",
  "unauthorized",
  "credentials",
  "forbidden",
  "missing",
  "conflict",
  "limit",
  "unreachable",
  "timeout",
  "query",
  "dependency",
  "port",
  "aborted",
  "unexpected",
];

/** Kinds where RETRYING the same operation can succeed. */
const RETRYABLE_KINDS: ReadonlySet<FaultKind> = new Set<FaultKind>([
  "unreachable",
  "timeout",
  "limit",
  "conflict",
  "aborted",
]);

/** The HTTP status that best expresses each origin when none is declared. */
export const FAULT_STATUS: Readonly<Record<FaultOrigin, number>> = Object.freeze({
  request: 400,
  auth: 401,
  app: 500,
  internal: 500,
  config: 500,
  db: 503,
  network: 502,
  dependency: 500,
  native: 500,
});

/** The origin implied by an HTTP status (4xx = caller's fault, 5xx = ours). */
export const originForStatus = (status: number): FaultOrigin => {
  if (status === 401 || status === 407) return "auth";
  if (status === 403) return "auth";
  if (status >= 400 && status < 500) return "request";
  return status >= 500 ? "internal" : "app";
};

/** The kind implied by an HTTP status. */
export const kindForStatus = (status: number): FaultKind => {
  switch (status) {
    case 400:
      return "invalid";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "missing";
    case 409:
      return "conflict";
    case 410:
      return "missing";
    case 422:
      return "invalid";
    case 429:
      return "limit";
    default:
      return status >= 500 ? "unexpected" : "invalid";
  }
};

/** Whether a kind is retryable unless the error says otherwise. */
export const isRetryableKind = (kind: FaultKind): boolean => RETRYABLE_KINDS.has(kind);

/**
 * The stable code for a failure: the declared one wins, otherwise
 * `IGN_<ORIGIN>_<KIND>` (`IGN_DB_CREDENTIALS`, `IGN_INTERNAL_UNEXPECTED`).
 *
 * @param origin - The subsystem that failed.
 * @param kind - The kind of failure.
 * @param declared - A code the error already declared, if any.
 * @returns The fault code.
 */
export const faultCode = (
  origin: FaultOrigin,
  kind: FaultKind,
  declared?: string | undefined,
): string => (declared && declared.length > 0 ? declared : `IGN_${origin}_${kind}`.toUpperCase());

/** The text of `Error.cause`, when the value carries one. */
export const causeOf = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "cause" in value
    ? (value as { cause?: unknown }).cause
    : undefined;

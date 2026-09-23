/**
 * @fileoverview Fault classification — turn ANY thrown value into a structured
 * {@link Fault}: which subsystem broke, what kind of failure it was, a stable
 * code, whether it is retryable, and what to do about it.
 *
 * Classification is deliberately structural, not magic: a typed `AppError`
 * (`DBError`, `ConfigError`, …) states its taxonomy outright; anything else is
 * read from the throw itself — its `cause` chain, its `code`/`codeName`, the
 * service markers in its messages, and the OS/driver error codes Node and Bun
 * attach (`ECONNREFUSED`, `EBADF`, `28P01`). A throw that matches nothing is
 * `internal`/`unexpected`, which is exactly the case worth investigating.
 *
 * Two rules keep reports trustworthy:
 *
 * 1. **A plain throw keeps its status.** Classification never upgrades an
 *    arbitrary `Error` to a 503 — only a typed error declares a status. The
 *    report tells the operator what broke; it does not change the wire behavior
 *    behind their back.
 * 2. **Nothing from a throw reaches a log unmasked.** Every quoted string goes
 *    through `redactLogText`, and the `cause` chain is flattened to
 *    name/message/code — never the raw driver object, whose enumerable BSON
 *    graphs are what made boot failures unreadable in the first place.
 */

import { isAppError, statusOf } from "./app-error";
import { hintsFor, summarize as summarizeFault } from "./fault-hints";
import {
  causesOf,
  chainText,
  errorChain,
  fieldOf,
  isRecord,
  issuesOf,
  MAX_LINE,
  messageOf,
  nameOf,
  whereFromStack,
} from "./fault-throw";
import {
  FAULT_STATUS,
  type Fault,
  type FaultKind,
  type FaultOrigin,
  isRetryableKind,
  kindForStatus,
  originForStatus,
} from "./fault-vocabulary";
import { redactLogText } from "./redact";

/** Service markers, in match order. */
const SERVICES: ReadonlyArray<readonly [string, RegExp]> = [
  ["MongoDB", /\bmongo|bson|MongoServerError|MongoNetworkError/i],
  ["PostgreSQL", /postgres|\bpg\b|28P01|3D000|PostgresError/i],
  ["Redis", /\bredis|WRONGPASS|NOAUTH/i],
  ["MySQL", /\bmysql|ER_ACCESS_DENIED_ERROR/i],
  ["SQLite", /sqlite|SQLITE_/i],
];

const CREDENTIALS =
  /requires authentication|authentication failed|not authorized|unauthorized|invalid password|password authentication failed|access denied|NOAUTH|WRONGPASS|28P01/i;
const UNREACHABLE =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|server selection|connection refused|socket hang up|getaddrinfo|no such host|connection closed/i;
const TIMEOUT = /ETIMEDOUT|ESOCKETTIMEDOUT|timed out|timeout exceeded|MaxTimeMSExpired/i;
const PORT_IN_USE = /EADDRINUSE|address already in use/i;
const MISSING_DEPENDENCY =
  /cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|dlopen|Failed to load native|not installed/i;
const ABORTED = /AbortError|aborted|The operation was aborted/i;
const QUERY =
  /query failed|syntax error|constraint|duplicate key|E11000|deadlock|relation .* does not exist/i;

/** A classified failure's structural facts. */
export interface Classified {
  readonly origin: FaultOrigin;
  readonly kind: FaultKind;
  readonly code?: string | undefined;
  readonly service?: string | undefined;
  readonly port?: number | undefined;
}

/** Pattern ladder for a throw that declares no taxonomy of its own. */
const classifyPatterns = (
  text: string,
  code: string | undefined,
  service: string | undefined,
): Classified => {
  if (PORT_IN_USE.test(text)) {
    const port = Number.parseInt(/:(\d{2,5})\b/.exec(text)?.[1] ?? "", 10);
    return { origin: "internal", kind: "port", ...(Number.isNaN(port) ? {} : { port }) };
  }
  // Credentials outrank reachability: a rejected credential is a configuration
  // problem, and driver messages often mention both.
  if (CREDENTIALS.test(text) || code === "13" || code === "18" || code === "28P01") {
    return { origin: service === undefined ? "config" : "db", kind: "credentials" };
  }
  if (TIMEOUT.test(text)) {
    return { origin: service === undefined ? "network" : "db", kind: "timeout" };
  }
  if (service !== undefined && QUERY.test(text)) return { origin: "db", kind: "query" };
  if (UNREACHABLE.test(text)) {
    return { origin: service === undefined ? "network" : "db", kind: "unreachable" };
  }
  if (MISSING_DEPENDENCY.test(text)) return { origin: "dependency", kind: "dependency" };
  if (ABORTED.test(text)) return { origin: "request", kind: "aborted" };
  if (text.startsWith("IGN_ENV_") || /environment validation failed/i.test(text)) {
    return { origin: "config", kind: "invalid" };
  }
  return { origin: "internal", kind: "unexpected" };
};

/** The service an error declares on itself (`DBError.service`, …). */
const declaredService = (thrown: unknown): string | undefined => {
  if (!isRecord(thrown)) return undefined;
  const service = (thrown as { service?: unknown }).service;
  return typeof service === "string" && service.length > 0 ? service : undefined;
};

/**
 * A library error that mapped itself onto HTTP semantics.
 *
 * Third-party layers (ninox's `DomainError`/`InfraError`, `http-errors`, most
 * ORMs) attach `status`/`statusCode` + a machine `code` to their errors rather
 * than importing this package's classes. Recognizing that shape is what keeps
 * `throw new DomainError("NOT_FOUND")` a 404 through the ignex boundary, and
 * what makes the report name the right origin — without a dependency in either
 * direction.
 *
 * `expose` (when present) says whether the message was written for a client.
 */
export interface MappedErrorFacts {
  /** The HTTP status the error declares (400–599). */
  readonly status: number;
  /** The machine code the error declares (`NOT_FOUND`, `MONGO_TIMEOUT`, …). */
  readonly code?: string | undefined;
  /** Whether the error says its message is client-safe. */
  readonly expose?: boolean | undefined;
  /** The error's own message. */
  readonly message: string;
}

/**
 * Read the mapped-error contract off a thrown value, or `undefined` when the
 * value does not declare one.
 *
 * Requires a plausible HTTP status AND a `code` or an explicit `expose` flag, so
 * a random error carrying an unrelated `status` field is not mistaken for a
 * typed one.
 *
 * @param thrown - The thrown value.
 * @returns The declared status/code/expose/message, or `undefined`.
 */
export const readMappedError = (thrown: unknown): MappedErrorFacts | undefined => {
  if (!isRecord(thrown)) return undefined;
  const record = thrown as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    expose?: unknown;
  };
  const raw = typeof record.statusCode === "number" ? record.statusCode : record.status;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 400 || raw > 599) {
    return undefined;
  }
  const code = typeof record.code === "string" && record.code.length > 0 ? record.code : undefined;
  const expose = typeof record.expose === "boolean" ? record.expose : undefined;
  if (code === undefined && expose === undefined) return undefined;
  return {
    status: raw,
    message: redactLogText(messageOf(thrown), MAX_LINE),
    ...(code === undefined ? {} : { code }),
    ...(expose === undefined ? {} : { expose }),
  };
};

/** Kind implied by a mapped error's code (`MONGO_TIMEOUT` → timeout). */
const KIND_BY_CODE: Readonly<Record<string, FaultKind>> = Object.freeze({
  BAD_REQUEST: "invalid",
  VALIDATION_FAILED: "invalid",
  NOT_FOUND: "missing",
  DUPLICATE_KEY: "conflict",
  VERSION_CONFLICT: "conflict",
  COLLECTION_EXISTS: "conflict",
  SCHEMA_DRIFT: "conflict",
  MONGO_TIMEOUT: "timeout",
});

/** Codes that name a datastore (`MONGO_*`, `PG_*`, …). */
const DB_CODE = /^(?:MONGO|MONGODB|PG|POSTGRES|MYSQL|REDIS|SQLITE|SQL)_/i;

/** Classify a mapped (library-declared) error from its status + code. */
const classifyMapped = (mapped: MappedErrorFacts): Classified => {
  const code = mapped.code;
  const kind =
    (code === undefined ? undefined : KIND_BY_CODE[code]) ??
    (code !== undefined && /TIMEOUT/i.test(code) ? "timeout" : undefined) ??
    (code !== undefined && /(?:AUTH|CREDENTIAL|UNAUTHORIZED)/i.test(code)
      ? "credentials"
      : undefined) ??
    (code !== undefined && /(?:CONNECTION|NETWORK|UNREACHABLE)/i.test(code)
      ? "unreachable"
      : undefined) ??
    (code !== undefined && /(?:QUERY|WRITE|READ|AGGREGATE|INDEX|SCHEMA)/i.test(code)
      ? "query"
      : undefined) ??
    kindForStatus(mapped.status);

  // A datastore code (`MONGO_QUERY_ERROR`) names the origin even when the status
  // is a bare 500.
  const dbCode = code !== undefined && DB_CODE.test(code);
  const origin: FaultOrigin = dbCode
    ? "db"
    : mapped.status >= 500
      ? "internal"
      : originForStatus(mapped.status);
  const service = dbCode && code !== undefined ? SERVICE_BY_CODE(code) : undefined;

  return {
    origin,
    kind,
    ...(code === undefined ? {} : { code }),
    ...(service === undefined ? {} : { service }),
  };
};

/** Datastore name for a `MONGO_*`-style code prefix. */
const SERVICE_BY_CODE = (code: string): string => {
  const prefix = code.slice(0, code.indexOf("_")).toUpperCase();
  switch (prefix) {
    case "MONGO":
    case "MONGODB":
      return "MongoDB";
    case "PG":
    case "POSTGRES":
      return "PostgreSQL";
    case "MYSQL":
      return "MySQL";
    case "REDIS":
      return "Redis";
    case "SQLITE":
    case "SQL":
      return "SQLite";
    default:
      return prefix;
  }
};

/** Classify a throw's facts into an origin + kind (+ the codes found on the way). */
const classify = (thrown: unknown, chain: readonly unknown[]): Classified => {
  const text = [chainText(chain), fieldOf(chain, "code") ?? "", fieldOf(chain, "codeName") ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
  const service = declaredService(thrown) ?? SERVICES.find(([, marker]) => marker.test(text))?.[0];
  const withService = (classified: Classified): Classified =>
    service === undefined ? classified : { ...classified, service };

  // A typed error (or a structured env report) knows its own taxonomy — trust
  // it over any pattern matching. A library error that declared a status + code
  // (the mapped-error contract) is trusted the same way.
  if (isAppError(thrown)) {
    return withService({ origin: thrown.origin, kind: thrown.kind, code: thrown.code });
  }
  const mapped = readMappedError(thrown);
  if (mapped !== undefined) return withService(classifyMapped(mapped));
  if (isRecord(thrown) && Array.isArray(thrown.issues)) {
    return withService({ origin: "config", kind: "invalid" });
  }

  return withService(classifyPatterns(text, fieldOf(chain, "code"), service));
};

/** One-line, human summary of a classified failure. */
const summarize = (classified: Classified, thrown: unknown): string =>
  summarizeFault(classified, nameOf(thrown));

/** Options for {@link toFault}. */
export interface ToFaultOptions {
  /** Operator-facing detail to surface (usually an `AppError`'s `detail`). */
  readonly detail?: string | undefined;
}

/**
 * Classify any thrown value into a {@link Fault}.
 *
 * Pure and total: it never throws, never reads files, and never mutates the
 * throw. Typed `AppError`s and library errors that declare a status keep their
 * declared taxonomy (and status); anything else is derived from the `cause`
 * chain and is always 500 at the boundary.
 *
 * @param thrown - Whatever was thrown (`Error`, string, driver object, …).
 * @param options - Caller-supplied detail to surface in the report.
 * @returns The structured fault.
 */
export const toFault = (thrown: unknown, options: ToFaultOptions = {}): Fault => {
  const chain = errorChain(thrown);
  const classified = classify(thrown, chain);
  const typed = isAppError(thrown) ? thrown : undefined;
  const mapped = typed === undefined ? readMappedError(thrown) : undefined;
  const message = redactLogText(
    [...chain]
      .reverse()
      .map(messageOf)
      .find((value) => value.length > 0) ?? "",
    MAX_LINE,
  );
  const hints = [
    ...(typed?.hint === undefined ? [] : [typed.hint]),
    ...hintsFor(classified, chain.length > 1),
  ];
  const detail = options.detail ?? typed?.detail;
  const where = whereFromStack(thrown);
  const issues = issuesOf(chain);
  const { origin, kind } = classified;
  // A plain throw is always a 500: only an error that DECLARES a status (our
  // typed family, or a library's mapped `statusCode`) may answer with one.
  const status = typed !== undefined ? statusOf(typed) : (mapped?.status ?? FAULT_STATUS.internal);

  return {
    origin,
    kind,
    code: classified.code ?? `IGN_${origin}_${kind}`.toUpperCase(),
    status,
    summary: summarize(classified, thrown),
    message,
    retryable: typed === undefined ? isRetryableKind(kind) : typed.retryable,
    hints,
    causes: causesOf(chain.slice(1)),
    issues,
    errorName: nameOf(thrown),
    ...(classified.service === undefined ? {} : { service: classified.service }),
    ...(detail === undefined ? {} : { detail }),
    ...(where === undefined ? {} : { where }),
  };
};

/** The canonical status for an origin when nothing declares one. */
export const statusForOrigin = (origin: FaultOrigin): number => FAULT_STATUS[origin];

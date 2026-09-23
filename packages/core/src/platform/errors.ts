/**
 * @fileoverview The error → response boundary, plus the public error surface.
 *
 * `errorToResponse` is the single place a thrown value becomes an HTTP response,
 * and therefore the single place a failure is *reported*. It:
 *
 * - maps typed errors to their status/code/envelope (the family lives in
 *   `http-errors.ts`),
 * - answers a generic 500 for anything else, with the message masked unless
 *   `exposeErrors` is on (the tail-masking rule: an internal message is not the
 *   client's business),
 * - reports every 5xx — typed or not — as a classified `Fault`, so the log line
 *   says *which subsystem broke and why* instead of dumping a stack trace. A 4xx
 *   stays quiet: a rejected request is the caller's fault, not an incident.
 *
 * The response envelope shape (`{ error, status, code, details? }`) is
 * deliberately unchanged — clients and the memoized fast path depend on it, and
 * correlation stays on the wire through `x-request-id`.
 *
 * The `export *` below keeps `@ignex/core/platform/errors` the single import
 * path for the whole error family, so existing `from "../platform/errors"`
 * imports — and downstream apps — keep working after the classes moved to
 * `http-errors.ts`.
 */

import { isAppError, statusOf } from "./app-error";
import { readMappedError, toFault } from "./fault";
import { faultRequestInfo, reportFault } from "./fault-report";
import { cachedErrorBody, genericStatusMessage, HTTPError, JSON_HEADERS } from "./http-errors";
import { redactLogText } from "./redact";

export * from "./http-errors";
export * from "./operational-errors";

/** Deterministic body for the generic internal error (no detail leak). */
const INTERNAL_ERROR_BODY = JSON.stringify({
  error: "Internal Server Error",
  status: 500,
  code: "INTERNAL_ERROR",
});

/** Title for a request-failure report. */
const REQUEST_FAILED_TITLE = "ignex request failed";

/** Label for the compact error a reported request failure returns. */
const REQUEST_FAILED = "[ignex] request failed";

/**
 * Resolve what a client may see for a thrown value.
 *
 * Split out of {@link errorToResponse} so the boundary reads as a pipeline
 * (report → answer) instead of a branch ladder. A typed or mapped error declares
 * its own status and whether its message was written for a client; a plain throw
 * is always a masked 500 whose code stays the stable `INTERNAL_ERROR` (its
 * classification belongs to the report, not the wire, and `x-request-id`
 * correlates the two).
 */
const resolveEnvelope = (
  err: unknown,
  exposeDetails: boolean,
): {
  status: number;
  code: string;
  message: string;
  details: Record<string, unknown> | undefined;
} => {
  const typed = isAppError(err) ? err : undefined;
  const mapped = typed === undefined ? readMappedError(err) : undefined;
  const status = typed !== undefined ? statusOf(typed) : (mapped?.status ?? 500);
  const code = typed?.code ?? mapped?.code ?? "INTERNAL_ERROR";
  const visible = typed !== undefined ? typed.expose : (mapped?.expose ?? status < 500);
  const authored = typed !== undefined ? typed.message : (mapped?.message ?? "");
  // Even an opted-in message is redacted: a driver message routinely embeds the
  // connection URL it failed on. Development opts in to detail, never to leaking
  // a password into a response body.
  const exposed = exposeDetails
    ? redactLogText(authored.length > 0 ? authored : err instanceof Error ? err.message : "")
    : "";
  const message =
    exposed.length > 0
      ? exposed
      : visible && authored.length > 0
        ? authored
        : genericStatusMessage(status);
  return {
    status,
    code,
    message,
    details: exposeDetails || visible ? typed?.details : undefined,
  };
};

/**
 * Convert any thrown value into an error `Response`.
 *
 * Typed errors map to their own status/code/body. Everything else becomes a 500:
 * the message is only exposed when `exposeDetails` is true (otherwise a generic
 * "Internal Server Error" envelope prevents detail leak) — but the failure is
 * always reported with its classification, so a masked 500 is still diagnosable
 * from the logs.
 *
 * @param err - The thrown value.
 * @param exposeDetails - Development / `exposeErrors`: include the real message
 *   (redacted) and `details`. Production is fail-closed for 5xx without it.
 * @param context - The request context, when there is one — adds
 *   method/path/route/requestId to the report (safe to omit).
 * @returns A JSON `Response` with security headers pre-applied.
 */
export const errorToResponse = (
  err: unknown,
  exposeDetails = false,
  context?: unknown,
): Response => {
  // An intentional client-facing status (400/403/404/…) is not an "unhandled"
  // error — never report it. A 5xx typed error IS an operator problem, so it is
  // reported like any other failure.
  if (err instanceof HTTPError) {
    if (err.status >= 500) {
      reportFault(err, {
        label: REQUEST_FAILED,
        title: REQUEST_FAILED_TITLE,
        request: faultRequestInfo(context),
      });
    }
    // The error decides what a client may see (4xx message, 5xx generic);
    // `exposeErrors` overrides it for a developer.
    return err.toResponse(undefined, { expose: exposeDetails });
  }

  const { status, code, message, details } = resolveEnvelope(err, exposeDetails);

  // Only a 5xx is an incident: classify and report it, so the log carries the
  // detail the envelope deliberately omits. A 4xx is the caller's business.
  if (status >= 500) {
    reportFault(err, {
      fault: toFault(err),
      label: REQUEST_FAILED,
      title: REQUEST_FAILED_TITLE,
      request: faultRequestInfo(context),
    });
  }

  // Hottest path: the generic, fully pre-baked 500.
  if (status === 500 && code === "INTERNAL_ERROR" && message === "Internal Server Error") {
    return new Response(INTERNAL_ERROR_BODY, { status: 500, headers: JSON_HEADERS });
  }

  return new Response(
    details === undefined
      ? cachedErrorBody(status, code, message)
      : JSON.stringify({ error: message, status, code, details }),
    { status, headers: JSON_HEADERS },
  );
};

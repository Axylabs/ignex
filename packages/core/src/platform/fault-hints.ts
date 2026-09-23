/**
 * @fileoverview Fault copy — the one-line summary and the "what to fix" hints for
 * a classified failure.
 *
 * Split from `fault.ts` (which owns the classification and the `Fault` shape) so
 * both stay small and the operator-facing wording lives in one reviewable place.
 * Pure functions over {@link Classified}: no I/O, no printing.
 */

import type { Classified } from "./fault";

/**
 * One-line, human summary of a classified failure — the `what` line of a report.
 *
 * @param classified - The classified failure.
 * @param errorName - Constructor name of the thrown value (`TypeError`, …).
 * @returns The summary sentence.
 */
export const summarize = (classified: Classified, errorName: string): string => {
  const { origin, kind, service } = classified;
  switch (kind) {
    case "credentials":
      return `${service ?? "The service"} rejected the credentials`;
    case "unreachable":
      return service === undefined
        ? `A network host is unreachable`
        : `${service} is not reachable`;
    case "timeout":
      return `${service ?? "The operation"} timed out`;
    case "query":
      return `${service ?? "The datastore"} rejected the operation`;
    case "port":
      return classified.port === undefined
        ? "The listen port is already in use"
        : `Port ${classified.port} is already in use`;
    case "dependency":
      return "A required dependency is missing or unusable";
    case "aborted":
      return "The operation was aborted";
    case "limit":
      return "A rate limit was hit";
    case "unauthorized":
      return "Authentication is missing or failed";
    case "forbidden":
      return "The caller is not allowed to perform this action";
    case "missing":
      return "The requested resource does not exist";
    case "conflict":
      return "The request conflicts with the current state";
    case "invalid":
      return origin === "config"
        ? "The environment or configuration is invalid"
        : "The request was invalid";
    default:
      return `Unhandled ${errorName}`;
  }
};

/**
 * Operator guidance for a classified failure, most-likely fix first.
 *
 * @param classified - The classified failure.
 * @param hasCauses - Whether the throw carried a `cause` chain (changes the
 *   advice for an unclassified failure: point at the chain, or at typing it).
 * @returns Up to four hints.
 */
export const hintsFor = (classified: Classified, hasCauses: boolean): readonly string[] => {
  const hints: string[] = [];
  const service = classified.service;

  switch (classified.kind) {
    case "credentials":
      hints.push(
        service === "MongoDB"
          ? "Check `MONGO_URL` in `.env` — user, password and `authSource` must match the server."
          : "Check the connection credentials in `.env` (user, password and auth/database scope).",
        "If the service runs without authentication, drop the `user:password@` part of the URL.",
        "Restart after editing `.env` — dotenv values are read once, at boot.",
      );
      break;
    case "unreachable":
      hints.push(
        `Is ${service ?? "the service"} running and reachable from here?`,
        "Check the host and port in the connection URL (`.env`).",
        "In Docker/Compose `localhost` is the container itself — use the service name (`mongo`, `db`, …).",
      );
      break;
    case "timeout":
      hints.push(
        "The operation exceeded its deadline — is the target slow or overloaded?",
        "Retry with a longer timeout, or reduce the work per call (pagination, batch size).",
      );
      break;
    case "query":
      hints.push(
        "The datastore rejected the operation itself — check the query, the schema and the indexes.",
        "A duplicate-key or constraint failure is app logic, not an outage: handle it explicitly.",
      );
      break;
    case "port":
      hints.push(
        "Another process already owns that port.",
        "Set `PORT` in `.env`, or free the port with `ignex dev --kill-port`.",
      );
      break;
    case "dependency":
      hints.push(
        "Run `bun install` — a package the app imports is missing.",
        "A plugin may import a package the app does not declare as a dependency.",
      );
      break;
    case "invalid":
      hints.push(
        classified.origin === "config"
          ? "Fix the missing/invalid values in `.env` (see the issues above), then restart."
          : "The caller's input was rejected — check the request against the route schema.",
      );
      break;
    case "aborted":
      hints.push(
        "A client disconnected or an outbound call was cancelled — usually not an app bug.",
      );
      break;
    case "limit":
      hints.push("The caller exceeded a quota — back off and retry after the advertised delay.");
      break;
    default:
      hints.push(
        "Set `IGNEX_DEBUG=1` to print the full error object and stack.",
        hasCauses
          ? "The cause chain below is the innermost failure — start there."
          : "Add a typed error (`DBError`, `ConfigError`, `UpstreamError`) where this is thrown to classify it.",
      );
  }
  return hints.slice(0, 4);
};

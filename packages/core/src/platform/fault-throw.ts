/**
 * @fileoverview Thrown-value introspection — read structure out of ANY throw.
 *
 * A driver hides the real failure behind `error.cause`, reports its state in
 * `code`/`codeName`, and points at a frame in a `stack`. These helpers extract
 * exactly that, safely: bounded depth, cycle-safe, total (never throws), and
 * every quoted string redacted through {@link redactLogText} before it can reach
 * a report.
 *
 * Split from `fault.ts` (which composes these into a {@link Fault}) because the
 * introspection is a self-contained concern — and because a raw object graph
 * must never leak past this boundary.
 */

import type { EnvIssue } from "./env-diagnostics";
import type { FaultCause } from "./fault-vocabulary";
import { causeOf } from "./fault-vocabulary";
import { redactLogText } from "./redact";

/** How far down an `Error.cause` chain to look for the real failure. */
export const MAX_CHAIN = 5;

/** Keep a report line readable. */
export const MAX_LINE = 200;

/** True for a non-null object — the guard every reader below starts from. */
export const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

/** The message of a thrown value (`Error`, string, or `{ message }` record). */
export const messageOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return "";
};

/** The constructor name of a thrown value (`MongoServerError`, `TypeError`, …). */
export const nameOf = (value: unknown): string =>
  value instanceof Error && value.name ? value.name : "Error";

/** Walk `error.cause` (bounded, cycle-safe) — drivers hide the real error there. */
export const errorChain = (thrown: unknown): readonly unknown[] => {
  const chain: unknown[] = [];
  let current: unknown = thrown;
  while (current != null && chain.length < MAX_CHAIN && !chain.includes(current)) {
    chain.push(current);
    current = causeOf(current);
  }
  return chain;
};

/** First `code`/`codeName`/`errno` string found along the chain. */
export const fieldOf = (chain: readonly unknown[], field: string): string | undefined => {
  for (const entry of chain) {
    if (!isRecord(entry)) continue;
    const value = entry[field];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
};

/** Combined text of the chain (names + messages) — the matching substrate. */
export const chainText = (chain: readonly unknown[]): string =>
  chain
    .map((entry) => `${nameOf(entry)} ${messageOf(entry)}`.trim())
    .filter((part) => part.length > 0)
    .join("\n");

/** The sanitized `cause` chain (deepest last) — names, messages and codes only. */
export const causesOf = (chain: readonly unknown[]): readonly FaultCause[] =>
  chain
    .map((entry) => {
      const message = messageOf(entry);
      const code = fieldOf([entry], "code") ?? fieldOf([entry], "codeName");
      return {
        name: nameOf(entry),
        message: redactLogText(message, MAX_LINE),
        ...(code === undefined ? {} : { code }),
      };
    })
    .filter((cause) => cause.message.length > 0);

/**
 * The first stack frame outside the framework and `node_modules` — the app code
 * that actually threw. Bun remaps this to TypeScript when the artifact ships a
 * sourcemap, so it is `file:line:column` of the operator's own source.
 */
export const whereFromStack = (thrown: unknown): string | undefined => {
  if (!(thrown instanceof Error) || typeof thrown.stack !== "string") return undefined;
  for (const line of thrown.stack.split("\n").slice(1)) {
    const frame = /\(?([^()\s]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (frame === null) continue;
    const file = frame[1] ?? "";
    if (file.includes("/node_modules/") || file.includes("/platform/fault")) continue;
    return `${file}:${frame[2]}:${frame[3]}`;
  }
  return undefined;
};

/** Collect structured env issues off a chain (duck-typed for `EnvError`). */
export const issuesOf = (chain: readonly unknown[]): readonly EnvIssue[] => {
  for (const entry of chain) {
    const value = isRecord(entry) ? (entry as { issues?: unknown }).issues : undefined;
    if (!Array.isArray(value)) continue;
    const issues = value.filter(
      (issue): issue is EnvIssue =>
        isRecord(issue) && typeof issue.key === "string" && typeof issue.message === "string",
    );
    if (issues.length > 0) return issues;
  }
  return [];
};

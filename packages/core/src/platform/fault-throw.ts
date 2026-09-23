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
 * A stack-frame rewriter that can turn a COMPILED frame into its source frame.
 *
 * The error system must not know what a source map is (the debug toolkit owns
 * that, and it is dev-only), so it only asks a registered remapper: return the
 * rewritten `at … (file:line:column)` line, or `null` when this frame has no
 * mapping. `null` is the signal {@link whereFromStack} uses to keep looking for
 * a frame that DOES resolve to a real source file.
 */
export type StackFrameRemapper = (frame: string) => string | null;

/** Process-wide frame remapper (installed by the debug layer when it boots). */
let frameRemapper: StackFrameRemapper | null = null;

/**
 * Install (or clear) the process-wide stack-frame remapper.
 *
 * Called by the debug toolkit (`installSourceFrames`) the moment it becomes
 * active, so every fault — boot failures included — reports `where` in the
 * operator's own `.ts` file rather than `dist/__server.js:1:48213`. `null`
 * restores raw bundle coordinates (used by tests, and the default in a process
 * where no sourcemap-aware layer is loaded).
 *
 * @param remap - The remapper, or `null` to clear it.
 */
export const setStackFrameRemapper = (remap: StackFrameRemapper | null): void => {
  frameRemapper = remap;
};

/** `file:line:column` of one stack-frame line, or `undefined` when it has none. */
const frameLocation = (line: string): string | undefined => {
  const frame = /\(?([^()\s]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
  return frame === null ? undefined : `${frame[1]}:${frame[2]}:${frame[3]}`;
};

/** Synthetic frames (`native:7:39`, `node:internal/…`) name no source file. */
const SYNTHETIC_FRAME = /^(?:native|node):/;

/** Framework frames: core's own source, linked or installed. */
const FRAMEWORK_FRAME = /(?:[\\/]packages[\\/]core[\\/]src[\\/]|[\\/]@ignex[\\/]core[\\/])/;

/** A real SOURCE position (the frame names a `.ts` file, not a compiled one). */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)(?::\d+:\d+)?$/i;

/**
 * How good a frame is as the answer to "where did this happen?" — higher wins,
 * the first frame wins ties.
 *
 * ```
 *  4 application source      3 dependency/framework source
 *  2 application compiled    1 dependency/framework compiled
 *  0 unusable
 * ```
 *
 * Source beats compiled, because a bundle offset (`dist/__server.js:1:48213`)
 * is not a location anyone can act on; among equal kinds, application code wins
 * because that is the frame the operator can change (a dependency frame — the
 * driver that raised the error, core rejecting a request — still beats saying
 * nothing). `0` covers synthetic `native:`/`node:` frames and the error system's
 * own frames: reporting those is what produced useless `where native:7:39`
 * lines.
 */
const whereRank = (where: string): number => {
  if (SYNTHETIC_FRAME.test(where) || !/[/\\]/.test(where)) return 0;
  if (where.includes("/platform/fault")) return 0;
  const dependency = FRAMEWORK_FRAME.test(where) || where.includes("/node_modules/");
  return (SOURCE_FILE.test(where) ? 3 : 1) + (dependency ? 0 : 1);
};

/**
 * The stack frame that says where the failure was raised, as
 * `file:line:column`.
 *
 * A compiled artifact reports bundle coordinates
 * (`dist/__server.js:1:48213`); the debug layer installs a sourcemap remapper
 * ({@link setStackFrameRemapper}) so those frames become the operator's own
 * `.ts` position — see {@link whereRank} for how a frame is chosen. Returns
 * `undefined` when no frame names a real file (a synthetic-only stack), which
 * renders as an absent `where` rather than a fake location.
 */
export const whereFromStack = (thrown: unknown): string | undefined => {
  if (!(thrown instanceof Error) || typeof thrown.stack !== "string") return undefined;
  let best: string | undefined;
  let bestRank = 0;
  for (const line of thrown.stack.split("\n").slice(1)) {
    const mapped = frameRemapper === null ? null : frameRemapper(line);
    const where = frameLocation(mapped ?? line);
    if (where === undefined) continue;
    const rank = whereRank(where);
    if (rank > bestRank) {
      best = where;
      bestRank = rank;
    }
  }
  return best;
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

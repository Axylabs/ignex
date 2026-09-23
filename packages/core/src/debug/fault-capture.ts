/**
 * @fileoverview Fault capture for the debugger — the one seam that turns a
 * thrown value into the wire-safe shapes the dashboard reads: the full
 * {@link TraceFault} (on the trace) and the compact {@link FaultMark} (on the
 * failed span and on every trace summary).
 *
 * The tracer never classifies a failure itself. It asks the error system
 * (`toFault`) exactly the way the terminal reporter does, so the fault an
 * operator read on stderr is the fault the dashboard shows — same origin, same
 * kind, same code, same hints, same sanitized cause chain. When a throw already
 * carries a fault (a reporter or a plugin boundary classified it), that
 * instance is reused (`faultOf`) instead of classifying twice.
 *
 * Cost is confined to the failure path: `toFault` runs only when a span or a
 * request FAILED, so tracing an error-free request is unchanged.
 */

import { toFault } from "../platform/fault";
import { faultOf } from "../platform/fault-report";
import type { Fault } from "../platform/fault-vocabulary";
import type { FaultMark, SpanAttrs } from "./types";

/**
 * Classify a thrown value the way the reporter does.
 *
 * Reuses the fault already attached to the throw when there is one, so the
 * debugger and the terminal report can never disagree about the same failure.
 *
 * @param thrown - Whatever was thrown (an `Error`, a driver object, a string).
 * @returns The classified fault.
 */
export const traceFault = (thrown: unknown): Fault => faultOf(thrown) ?? toFault(thrown);

/**
 * Compact classification of a fault — what a trace summary and a failed span
 * carry (code + taxonomy + service + first app frame).
 *
 * @param fault - The classified fault.
 * @returns The compact mark.
 */
export const faultMark = (fault: Fault): FaultMark => ({
  code: fault.code,
  origin: fault.origin,
  kind: fault.kind,
  ...(fault.service === undefined ? {} : { service: fault.service }),
  ...(fault.where === undefined ? {} : { where: fault.where }),
});

/** Classify a throw and compact it in one step (the span-failure path). */
export const markOf = (thrown: unknown): FaultMark => faultMark(traceFault(thrown));

/**
 * `MongoServerError: Command create requires authentication (code 13)` — one
 * readable line per entry of the sanitized cause chain, the same wording the
 * terminal report uses.
 *
 * @param cause - One entry of {@link Fault.causes}.
 * @returns The formatted line.
 */
export const formatCause = (cause: Fault["causes"][number]): string =>
  `${cause.name}: ${cause.message}${cause.code === undefined ? "" : ` (code ${cause.code})`}`;

/**
 * Attrs for the `error` event span — the classification travels with the row,
 * so the waterfall explains the failure without opening the Error tab.
 *
 * @param fault - The classified fault.
 * @param stack - The captured (sourcemapped) stack, when there is one.
 * @returns Span attributes (JSON-safe, already redacted by the classifier).
 */
export const faultAttrs = (fault: Fault, stack: string | null): SpanAttrs => ({
  error: fault.message.length > 0 ? fault.message : fault.summary,
  ...(stack === null ? {} : { stack }),
  code: fault.code,
  origin: fault.origin,
  kind: fault.kind,
  retryable: fault.retryable,
  ...(fault.service === undefined ? {} : { service: fault.service }),
  ...(fault.where === undefined ? {} : { where: fault.where }),
});

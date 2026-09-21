/**
 * @fileoverview Span-id source for debug traces: a pure, injectable counter
 * factory. Kept in its own module so id generation is scoped per tracer
 * instead of hiding a process-wide counter inside the (large) tracer file.
 */

/**
 * Span-id source: yields the next numeric span id. Pure, injectable, so tests
 * and libraries can scope id generation per tracer instead of fighting a
 * hidden process-wide counter.
 */
export type SpanIdSource = () => number;

/**
 * Create a fresh span-id source starting at `start` (default 1), strictly
 * increasing per call. Independent sources never share ids.
 */
export const createSpanIdSource = (start = 1): SpanIdSource => {
  let next = start;
  return (): number => next++;
};

/**
 * Process-wide default span-id source. Shared by every `Trace` that does not
 * inject its own source so ids stay globally unique and ordered across traces
 * in the debugbar UI.
 */
export const defaultSpanIds: SpanIdSource = createSpanIdSource();

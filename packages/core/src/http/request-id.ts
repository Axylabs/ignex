/**
 * @fileoverview Request ID generation — monotonic counter-based ids that need
 * no crypto RNG on the hot path. Shared by `createContext` and tracing.
 */

let requestIdCounter = 0;
// The millisecond component changes at most once per ms, and at real request
// rates many requests share a millisecond — so the base-36 conversion (one of
// the two `toString(36)` calls on this per-request path) is memoized on the
// current ms value instead of recomputed for every request.
let lastMs = -1;
let lastMsBase36 = "";

/**
 * Generate a request id: a base-36 millisecond stamp plus a monotonic counter.
 *
 * Exported so the compiler's usage-specialized context can emit
 * `requestId: generateRequestId()` for a route that reads `ctx.requestId`
 * without forcing the full context — it must be the SAME generator
 * `IgnexContextImpl`'s lazy `requestId` getter calls, or a compiled build and an
 * interpreted one would mint different ids for the same request.
 *
 * @returns A process-unique id, e.g. `"mb3k4f-1a2"`.
 */
export const generateRequestId = (): string => {
  // `Math.floor` avoids the fractional `.` produced by
  // `performance.now().toString(36)` (and its `.replace` copy); the monotonic
  // counter disambiguates requests that land in the same integer millisecond.
  const ms = Math.floor(performance.now());

  if (ms !== lastMs) {
    lastMs = ms;
    lastMsBase36 = ms.toString(36);
  }

  const seq = (++requestIdCounter).toString(36);
  return `${lastMsBase36}-${seq}`;
};

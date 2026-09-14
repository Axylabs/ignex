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

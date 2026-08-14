/**
 * @fileoverview Request ID generation — monotonic counter-based ids that need
 * no crypto RNG on the hot path. Shared by `createContext` and tracing.
 */

let requestIdCounter = 0;

export const generateRequestId = (): string => {
  // `Math.floor` avoids the fractional `.` produced by
  // `performance.now().toString(36)` (and its `.replace` copy); the monotonic
  // counter disambiguates requests that land in the same integer millisecond.
  const ts = Math.floor(performance.now()).toString(36);
  const seq = (++requestIdCounter).toString(36);
  return `${ts}-${seq}`;
};

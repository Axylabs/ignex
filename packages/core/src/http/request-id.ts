/**
 * @fileoverview Request ID generation — monotonic counter-based ids that need
 * no crypto RNG on the hot path. Shared by `createContext` and tracing.
 */

let requestIdCounter = 0;

export const generateRequestId = (): string => {
  const ts = performance.now().toString(36).replace(".", "");
  const seq = (++requestIdCounter).toString(36);
  return `${ts}-${seq}`;
};

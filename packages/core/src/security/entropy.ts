/**
 * @fileoverview CSPRNG-backed entropy helpers for sequence ids: hex suffixes
 * and per-instance scoped id generators (counter + timestamp + random suffix).
 * `Math.random()` is never acceptable here — ids would be sequential-guessable
 * and not unique across processes.
 */

/**
 * Encode `bytes` CSPRNG bytes (Web Crypto) as lowercase hex.
 *
 * @param bytes - Number of random bytes.
 * @returns `bytes * 2` hex chars.
 */
export const randomHex = (bytes: number): string => {
  const rand = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (const byte of rand) out += byte.toString(16).padStart(2, "0");
  return out;
};

/**
 * Create an instance-scoped id generator: `<prefix>-<ts36>-<seq36>-<hex>`,
 * monotonic enough for the debug UI and unique across processes.
 *
 * The counter lives in the returned closure, so two generators never share
 * hidden sequence state; the suffix draws from the CSPRNG instead of
 * `Math.random()`.
 *
 * @param prefix - Id namespace (`"ev"`, `"sched"`, …).
 * @param suffixHexBytes - CSPRNG suffix size in bytes (default 3).
 * @returns A fresh `() => string` id function.
 */
export const createScopedId = (prefix: string, suffixHexBytes = 3): (() => string) => {
  let seq = 0;
  return () => {
    seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}-${randomHex(suffixHexBytes)}`;
  };
};

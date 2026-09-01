/**
 * @fileoverview String → typed coercion helpers — single source of truth for
 * the accepted value formats, shared by `env.ts` and `config.ts`.
 *
 * The boolean formats (`1/true/yes/on`, `0/false/no/off`) are used by both
 * `envBool` and `defineConfig`'s `"boolean"` coercion; number parsing is kept
 * per-caller because `envInt`/`envFloat` intentionally truncate (`parseInt` /
 * `parseFloat`) while `defineConfig`'s `"number"` is strict (`Number`).
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Parse a boolean-ish string. Returns `undefined` when the value is not a
 * recognized boolean format — callers decide the fallback.
 */
export const coerceBoolean = (raw: string): boolean | undefined => {
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return undefined;
};

/**
 * Extract the last (rightmost) entry from an `x-forwarded-for` header.
 *
 * SECURITY: never key on the LEFTMOST entry — it is fully client-controlled
 * when any proxy appends to the chain (`X-Forwarded-For: spoofed, <real>`).
 * With a single trusted proxy in front of the server, the rightmost entry is
 * the one YOUR proxy appended and cannot be chosen by the client (the proxy
 * overwrites/appends after whatever the client sent), making it the correct,
 * non-spoofable client identity for rate limiting and other security
 * decisions. Multi-proxy chains need per-hop trust configuration instead.
 * Returns `undefined` when absent or blank.
 */
export const lastForwardedIp = (xff: string | null | undefined): string | undefined => {
  if (!xff) return undefined;
  const entries = xff.split(",");
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i]?.trim();
    if (candidate) return candidate;
  }
  return undefined;
};

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
 * Extract the first (original-client) IP from an `x-forwarded-for` header.
 * The value is a comma-separated chain; the leftmost entry is the client when
 * each proxy appends. Returns `undefined` when absent or blank.
 */
export const firstForwardedIp = (xff: string | null | undefined): string | undefined =>
  xff?.split(",")[0]?.trim() || undefined;

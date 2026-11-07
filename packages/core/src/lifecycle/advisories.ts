/**
 * @fileoverview Boot-time security advisories — one-line production warnings
 * for app shapes that are legal but usually a mistake: serving without the
 * security-headers plugin, or cookie sessions without a CSRF guard.
 *
 * Advisories are NEVER failures (a stateless JSON API legitimately ships
 * without CSP); they fire once per process, only when `NODE_ENV=production`
 * (dev noise would train people to ignore them), and `IGNEX_SILENCE_ADVISORIES=1`
 * mutes them for deliberate shapes.
 */
import type { IgnexPlugin } from "../lifecycle/plugin/types";

/** Mute env for deliberate advisory-free shapes (checked once). */
const SILENCE_ENV = "IGNEX_SILENCE_ADVISORIES";

/** Advisories to print for the plugin stack, in check order. */
export const reportSecurityAdvisories = (plugins: readonly IgnexPlugin[] | undefined): void => {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env[SILENCE_ENV] === "1") return;

  const names = new Set((plugins ?? []).map((p) => p.name));

  if (!names.has("security")) {
    console.warn(
      "[ignex] security advisory: no security-headers plugin — responses ship without CSP, " +
        "nosniff, frame or referrer protection. Add `security()` from @ignex/core (or mute " +
        `with ${SILENCE_ENV}=1).`,
    );
  }

  if (names.has("session") && !names.has("csrf")) {
    console.warn(
      "[ignex] security advisory: cookie sessions without a CSRF guard — state-changing " +
        "routes are open to cross-site posts. Add `csrfGuard({ secret })` (or mute with " +
        `${SILENCE_ENV}=1).`,
    );
  }
};

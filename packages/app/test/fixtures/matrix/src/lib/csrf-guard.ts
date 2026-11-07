/**
 * Shared CSRF guard for the /csrf routes.
 *
 * One guard instance (same secret → same HMAC key ring, same cookie name) is
 * used by BOTH the minting GET route and the protected POST route, exactly
 * like an app shares one guard across its form routes.
 */
import { createCsrfGuard } from "@ignex/core";

/** Dev-secret double-submit guard (env override keeps the fixture hermetic). */
export const csrfGuard = createCsrfGuard({
  secret: process.env.CSRF_SECRET ?? "matrix-csrf-dev-secret",
});

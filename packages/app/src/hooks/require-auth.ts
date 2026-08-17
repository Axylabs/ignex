/**
 * Shared auth hook: verifies a Bearer token with the app's auth module
 * (Ed25519 JWT) and attaches the claims to `ctx.state`. Used by routes via
 * `export const config = { hooks: [...] }`.
 */
import { requireAuth } from "../lib/auth.js";

export default requireAuth;

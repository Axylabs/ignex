/**
 * @fileoverview Public sub-barrel: security (auth, crypto, csrf, session)
 * re-exported from the `@ignex/core` entry (split from the barrel `src/index.ts`
 * by section banner — move-only; `export` statements verbatim).
 */

// ── security ────────────────────────────────────────────────────
export type { AuthUser, JwtAuthOptions } from "../security/auth";
export {
  basicAuth,
  bearerAuth,
  forbidden,
  getUser,
  jwtAuth,
  optionalAuth,
  requireAuth,
  setUser,
  USER_KEY,
  unauthorized,
} from "../security/auth";
export type {
  CookieSigner,
  Csrf,
  Ed25519JwtOptions,
  Ed25519JwtService,
  JwtService,
  JwtServiceOptions,
  PasswordHasher,
} from "../security/crypto";
export {
  aeadDecrypt,
  aeadEncrypt,
  createAead,
  createCookieSigner,
  createCsrf,
  createEd25519Jwt,
  createJwt,
  createPasswordHasher,
  csrfToken,
  csrfVerify,
  hmacSha256,
  hmacSha256Verify,
  jwtSign,
  jwtVerify,
  passwordHash,
  passwordVerify,
  randomToken,
  signCookie,
  verifyCookie,
} from "../security/crypto";
export type { CsrfGuardOptions } from "../security/csrf";
export { createCsrfGuard } from "../security/csrf";
export { devSessionSecret } from "../security/dev-secret";
export type {
  Session,
  SessionManager,
  SessionManagerOptions,
  SessionStore,
  SessionStoreOptions,
} from "../security/session";
export {
  createMemorySessionStore,
  createSessionManager,
  createSessionStoreFromStore,
  createSqliteSessionStore,
  getSession,
} from "../security/session";

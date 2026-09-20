/**
 * @fileoverview Crypto barrel — re-exports the full 31-name crypto surface
 * that the pre-split `crypto.ts` exported, now grouped by domain file so every
 * existing `import { … } from "./crypto"` (and `@ignex/native` entry
 * re-export) resolves unchanged.
 */

export { aeadDecrypt, aeadDecryptFallback, aeadEncrypt, aeadEncryptFallback } from "./aead";
export { signCookie, signCookieFallback, verifyCookie, verifyCookieFallback } from "./cookie";
export { csrfToken, csrfTokenFallback, csrfVerify, csrfVerifyFallback } from "./csrf";
export { hmacSha256, hmacSha256Verify } from "./hmac";
export type { JwtSignOptions, JwtVerifyOptions } from "./jwt";
export { jwtSign, jwtSignFallback, jwtVerify, jwtVerifyFallback } from "./jwt";
export type { PasswordHashOptions } from "./password";
export {
  canVerifyPasswordHash,
  passwordHash,
  passwordHashAlgorithm,
  passwordHashFallback,
  passwordVerify,
  passwordVerifyFallback,
} from "./password";
export { sessionOpen, sessionSeal } from "./session";
export { randomToken, randomTokenFallback } from "./token";

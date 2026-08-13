/**
 * High-level security primitives: JWT, signed cookies, CSRF, passwords and
 * AEAD encryption — backed by the Rust addon through `@ignus/native` (with
 * byte-compatible pure-TS fallbacks). Composable, stateless, safe by default.
 */
import { randomBytes } from "node:crypto";
import {
  aeadDecrypt,
  aeadEncrypt,
  csrfToken,
  csrfVerify,
  hmacSha256,
  hmacSha256Verify,
  type JwtVerifyOptions,
  jwtSign,
  jwtVerify,
  type PasswordHashOptions,
  passwordHash,
  passwordVerify,
  randomToken,
  signCookie,
  verifyCookie,
} from "@ignus/native";

export type {
  JwtSignOptions,
  JwtVerifyOptions,
  PasswordHashOptions,
} from "@ignus/native";

// Low-level primitives (re-exported for direct use).
export {
  aeadDecrypt,
  aeadEncrypt,
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
};

/**
 * Reject an empty secret/key at construction time.
 *
 * An empty secret makes every produced token/signature trivially forgeable,
 * so it is a programming error, not something to degrade gracefully on.
 */
function assertSecret(secret: string | Uint8Array, what: string): void {
  if (secret.length === 0) {
    throw new TypeError(`${what} requires a non-empty secret`);
  }
}

/** Options for {@link createJwt}. */
export interface JwtServiceOptions {
  secret: string | Uint8Array;
  /** Fixed TTL in seconds (injects `iat`/`exp` when positive). */
  ttlSeconds?: number;
  /** `iss` claim injected on sign and enforced on verify. */
  issuer?: string;
  /** `aud` claim(s) injected on sign and enforced on verify. */
  audience?: string | string[];
}

/** A reusable HS256 JWT signer/verifier from {@link createJwt}. */
export interface JwtService {
  /** Sign an HS256 token with the configured issuer/audience/TTL applied. */
  sign(claims: Record<string, unknown>, nowSeconds?: number): string;
  /** Verify + validate `iss`/`aud`; returns the claims or `null`. */
  verify(token: string, options?: JwtVerifyOptions): unknown;
}

/**
 * Create a reusable HS256 JWT signer/verifier.
 *
 * @param options - Secret plus optional TTL/issuer/audience constraints.
 * @throws TypeError when `options.secret` is empty.
 */
export const createJwt = (options: JwtServiceOptions): JwtService => {
  assertSecret(options.secret, "createJwt");
  const { secret, ttlSeconds, issuer, audience } = options;

  const withMeta = (claims: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...claims };
    if (issuer) out.iss = issuer;
    if (audience) out.aud = audience;
    return out;
  };

  const validate = (claims: unknown): unknown => {
    if (claims == null || typeof claims !== "object") return null;
    const c = claims as Record<string, unknown>;
    if (issuer && c.iss !== issuer) return null;
    if (audience) {
      const expected = Array.isArray(audience) ? audience : [audience];
      const actual = Array.isArray(c.aud) ? (c.aud as unknown[]) : [c.aud];
      if (!expected.some((a) => actual.includes(a))) return null;
    }
    return claims;
  };

  return {
    sign(claims, nowSeconds = Math.floor(Date.now() / 1000)): string {
      return jwtSign(withMeta(claims), secret, {
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        nowSeconds,
      });
    },

    verify(token, verifyOptions = {}): unknown {
      const verifyOpts: JwtVerifyOptions = {};
      if (verifyOptions.nowSeconds !== undefined) {
        verifyOpts.nowSeconds = verifyOptions.nowSeconds;
      }
      return validate(jwtVerify(token, secret, verifyOpts));
    },
  };
};

/** A reusable signed-cookie signer/verifier from {@link createCookieSigner}. */
export interface CookieSigner {
  sign(value: string): string;
  verify(signed: string): string | null;
}

/**
 * Create a reusable signed-cookie signer/verifier.
 *
 * @param secret - HMAC key; must be non-empty.
 * @throws TypeError when `secret` is empty.
 */
export const createCookieSigner = (secret: string | Uint8Array): CookieSigner => {
  assertSecret(secret, "createCookieSigner");
  return {
    sign: (value) => signCookie(value, secret),
    verify: (signed) => verifyCookie(signed, secret),
  };
};

/** A reusable CSRF token generator/verifier from {@link createCsrf}. */
export interface Csrf {
  /** Create a new CSRF token (random + HMAC-signed). */
  token(): string;
  /** Constant-time verify of a CSRF token. */
  verify(token: string): boolean;
}

/**
 * Create a reusable CSRF token generator/verifier.
 *
 * @param secret - HMAC key; must be non-empty.
 * @throws TypeError when `secret` is empty.
 */
export const createCsrf = (secret: string | Uint8Array): Csrf => {
  assertSecret(secret, "createCsrf");
  return {
    token: () => csrfToken(secret),
    verify: (token) => csrfVerify(token, secret),
  };
};

/** A reusable password hasher/verifier from {@link createPasswordHasher}. */
export interface PasswordHasher {
  /** Hash a password with a fresh random salt → PHC string. */
  hash(password: string): Promise<string>;
  /** Verify a password against a PHC string. */
  verify(password: string, phc: string): boolean;
}

/** Create a password hasher (argon2id native / scrypt fallback). */
export const createPasswordHasher = (options?: PasswordHashOptions): PasswordHasher => ({
  hash: async (password) => passwordHash(password, randomBytes(16), options),
  verify: (password, phc) => passwordVerify(password, phc),
});

/** A reusable AEAD cipher from {@link createAead}. */
export interface Aead {
  /** Encrypt → ciphertext ‖ 16-byte tag. */
  encrypt(nonce: Uint8Array, plaintext: Uint8Array, algorithm?: string | null): Uint8Array;
  /** Decrypt; returns `null` on auth failure. */
  decrypt(nonce: Uint8Array, ciphertext: Uint8Array, algorithm?: string | null): Uint8Array | null;
}

/**
 * Create a reusable AEAD cipher (AES-256-GCM by default).
 *
 * @param key - Symmetric key; must be non-empty.
 * @throws TypeError when `key` is empty.
 */
export const createAead = (key: Uint8Array): Aead => {
  assertSecret(key, "createAead");
  return {
    encrypt: (nonce, plaintext, algorithm) => aeadEncrypt(key, nonce, plaintext, algorithm),
    decrypt: (nonce, ciphertext, algorithm) => aeadDecrypt(key, nonce, ciphertext, algorithm),
  };
};

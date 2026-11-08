/**
 * High-level security primitives: JWT, signed cookies, CSRF, passwords and
 * AEAD encryption — backed by the Rust addon through `@ignex/native` (with
 * byte-compatible pure-TS fallbacks). Composable, stateless, safe by default.
 */
import {
  aeadDecrypt,
  aeadEncrypt,
  csrfToken,
  csrfVerify,
  hmacSha256,
  hmacSha256Verify,
  type JwtVerifyOptions,
  jwtSign,
  jwtSignEdDsa,
  jwtVerify,
  jwtVerifyEdDsa,
  type PasswordHashOptions,
  passwordHash,
  passwordHashAsync,
  passwordVerify,
  randomToken,
  signCookie,
  type TaskRunOptions,
  verifyCookie,
  verifyPasswordAsync,
} from "@ignex/native";
import {
  normalizeSecrets,
  type SecretInput,
  signSecret,
  verifyBoolWithRing,
  verifyWithRing,
} from "./keyring";

export type {
  JwtVerifyOptions,
  PasswordHashOptions,
} from "@ignex/native";
export type { SecretInput } from "./keyring";

// Low-level primitives (re-exported for direct use).
export {
  aeadDecrypt,
  aeadEncrypt,
  csrfToken,
  csrfVerify,
  hmacSha256,
  hmacSha256Verify,
  jwtSign,
  jwtSignEdDsa,
  jwtVerify,
  jwtVerifyEdDsa,
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
  /**
   * HS256 secret — or a rotation ring (current first, previous after).
   * Signs with the current secret; verifies against every ring entry.
   */
  secret: SecretInput;
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
 * Warn ONCE per service when a JWT service is created without a TTL: every
 * token it mints will lack `exp`, and `verify()` now rejects such tokens by
 * default (`requireExp`), so the misconfiguration fails loudly at the edges
 * instead of silently minting permanent credentials.
 */
let warnedNoTtl = false;
const warnNoTtl = (): void => {
  if (warnedNoTtl) return;
  warnedNoTtl = true;
  console.warn(
    "[ignex] JWT service created without ttlSeconds and without an exp claim policy: " +
      "minted tokens never expire. Set ttlSeconds, include exp in claims, or pass " +
      "{ requireExp: false } to verify() to accept non-expiring tokens explicitly.",
  );
};

/**
 * Create a reusable HS256 JWT signer/verifier.
 *
 * @param options - Secret plus optional TTL/issuer/audience constraints.
 * @throws TypeError when `options.secret` is empty.
 */
export const createJwt = (options: JwtServiceOptions): JwtService => {
  const secrets = normalizeSecrets(options.secret);
  if (options.ttlSeconds === undefined) warnNoTtl();
  const { ttlSeconds, issuer, audience } = options;

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
      return jwtSign(withMeta(claims), signSecret(secrets), {
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        nowSeconds,
      });
    },

    verify(token, verifyOptions = {}): unknown {
      const verifyOpts: JwtVerifyOptions = {};
      if (verifyOptions.nowSeconds !== undefined) {
        verifyOpts.nowSeconds = verifyOptions.nowSeconds;
      }
      if (verifyOptions.requireExp !== undefined) {
        verifyOpts.requireExp = verifyOptions.requireExp;
      }
      return validate(verifyWithRing(secrets, (secret) => jwtVerify(token, secret, verifyOpts)));
    },
  };
};

/** Options for {@link createEd25519Jwt}. */
export interface Ed25519JwtOptions {
  /** PKCS#8 v1 DER private key, base64url (or raw DER bytes). */
  privateKey: string | Uint8Array;
  /**
   * SPKI DER public key — or a rotation ring (current first, previous after).
   * Signs with the current key; verifies against every ring entry.
   */
  publicKey: SecretInput;
  /** Fixed TTL in seconds (injects `iat`/`exp` when positive). */
  ttlSeconds?: number;
  /** `iss` claim injected on sign and enforced on verify. */
  issuer?: string;
  /** `aud` claim(s) injected on sign and enforced on verify. */
  audience?: string | string[];
}

/** A reusable EdDSA (Ed25519) JWT signer/verifier from {@link createEd25519Jwt}. */
export interface Ed25519JwtService {
  /** Sign an EdDSA token with the configured issuer/audience/TTL applied. */
  sign(claims: Record<string, unknown>, nowSeconds?: number): string;
  /** Verify + validate `iss`/`aud`; returns the claims or `null`. */
  verify(token: string, options?: { nowSeconds?: number; requireExp?: boolean }): unknown;
}

/**
 * Create a reusable EdDSA (Ed25519) JWT signer/verifier.
 *
 * Signed through the Rust addon (`castrum`) via `@ignex/native` with a
 * byte-compatible pure-TS fallback; the keypair is the base64url DER format
 * produced by {@link generateEd25519Keypair} (and written to `.env` by the
 * auth module only outside production when bootstrap is enabled).
 *
 * @throws TypeError when `options.privateKey`/`options.publicKey` are empty.
 */
export const createEd25519Jwt = (options: Ed25519JwtOptions): Ed25519JwtService => {
  assertSecret(options.privateKey, "createEd25519Jwt");
  const publicKeys = normalizeSecrets(options.publicKey);
  if (options.ttlSeconds === undefined) warnNoTtl();
  const { privateKey, ttlSeconds, issuer, audience } = options;

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
      return jwtSignEdDsa(withMeta(claims), privateKey, {
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        nowSeconds,
      });
    },

    verify(token, verifyOptions = {}): unknown {
      const verifyOpts: { nowSeconds?: number; requireExp?: boolean } = {};
      if (verifyOptions.nowSeconds !== undefined) {
        verifyOpts.nowSeconds = verifyOptions.nowSeconds;
      }
      if (verifyOptions.requireExp !== undefined) {
        verifyOpts.requireExp = verifyOptions.requireExp;
      }
      return validate(
        verifyWithRing(publicKeys, (publicKey) => jwtVerifyEdDsa(token, publicKey, verifyOpts)),
      );
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
 * @param secret - HMAC key, or a rotation ring (current first, previous
 *   after): signs with the current, verifies against every entry.
 * @throws TypeError when `secret` is empty.
 */
export const createCookieSigner = (secret: SecretInput): CookieSigner => {
  const secrets = normalizeSecrets(secret);
  return {
    sign: (value) => signCookie(value, signSecret(secrets)),
    verify: (signed) => verifyWithRing(secrets, (entry) => verifyCookie(signed, entry)),
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
 * @param secret - HMAC key, or a rotation ring (current first, previous
 *   after): mints with the current, verifies against every entry.
 * @throws TypeError when `secret` is empty.
 */
export const createCsrf = (secret: SecretInput): Csrf => {
  const secrets = normalizeSecrets(secret);
  return {
    token: () => csrfToken(signSecret(secrets)),
    verify: (token) => verifyBoolWithRing(secrets, (entry) => csrfVerify(token, entry)),
  };
};

/** A reusable password hasher/verifier from {@link createPasswordHasher}. */
export interface PasswordHasher {
  /** Hash a password with a fresh random salt → PHC string. */
  hash(password: string): Promise<string>;
  /** Verify a password against a PHC string. */
  verify(password: string, phc: string): boolean;
  /**
   * Verify a password off the JS event loop. Scrypt uses Node's async crypto;
   * argon2id uses the native task pool when available. Native runtime failures
   * fall back to {@link PasswordHasher.verify}, preserving the boolean result
   * on every backend (`IGNEX_NATIVE=off` included).
   *
   * @param password - Cleartext password.
   * @param phc - Stored PHC hash (`$argon2id$…` or `$scrypt$…`).
   * @param options - Optional abort signal.
   * @returns `true` when the password matches the hash.
   */
  verifyAsync(password: string, phc: string, options?: TaskRunOptions): Promise<boolean>;
}

/** Create a password hasher using portable scrypt by default. */
export const createPasswordHasher = (options?: PasswordHashOptions): PasswordHasher => ({
  hash: async (password) => {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    return passwordHashAsync(password, salt, options);
  },
  verify: (password, phc) => passwordVerify(password, phc),
  verifyAsync: (password, phc, runOptions) => verifyPasswordAsync(password, phc, runOptions),
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

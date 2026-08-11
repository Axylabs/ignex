/**
 * Cryptography primitives for backend auth & security, backed by the Rust
 * addon when available and falling back to byte-compatible pure-TS
 * implementations (Node `crypto` built-ins).
 *
 * Formats are locked to the native addon:
 * - signed cookies: `value.<64-hex(HMAC-SHA256(secret, value))>`
 * - CSRF tokens:    `<64-hex(random)>.<64-hex(HMAC-SHA256(secret, rnd_hex))>`
 * - JWT:            HS256 compact token with `iat`/`exp` injection
 * - passwords:      argon2id PHC (native) or `$scrypt$` PHC (fallback)
 * - AEAD:           AES-256-GCM, ciphertext ‖ 16-byte tag
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { nativeFor } from "./runtime";
import {
  b64urlDecode,
  b64urlEncode,
  ctEqual,
  encoder,
  fromBytes,
  hexDecode,
  hexEncode,
  hmacSha256Bytes,
  toBytes,
  toPlain,
} from "./util";

export interface JwtSignOptions {
  /** Time-to-live in seconds (injects `iat`/`exp` when positive). */
  ttlSeconds?: number;
  /** Current epoch seconds (defaults to `Date.now() / 1000`). */
  nowSeconds?: number;
}

export interface JwtVerifyOptions {
  /** Current epoch seconds (defaults to `Date.now() / 1000`). */
  nowSeconds?: number;
}

export interface PasswordHashOptions {
  /** Memory cost in KiB (argon2id `m`; default 19_456). */
  mCost?: number;
  /** Iterations (`t`; default 2). */
  tCost?: number;
  /** Parallelism (`p`; default 1). */
  pCost?: number;
  /** Output length in bytes (default 32). */
  outLen?: number;
}

/** Clock-skew leeway (seconds) for the `iat` claim — matches native. */
const IAT_LEEWAY_SECONDS = 60;

// ── HMAC-SHA256 ─────────────────────────────────────────────────

export const hmacSha256 = (key: string | Uint8Array, data: string | Uint8Array): Uint8Array => {
  const k = toBytes(key);
  const d = toBytes(data);
  const nv = nativeFor("hmacSha256");
  if (nv) return toPlain(nv.hmacSha256(k, d));
  return hmacSha256Bytes(k, d);
};

export const hmacSha256Verify = (
  key: string | Uint8Array,
  data: string | Uint8Array,
  sig: string | Uint8Array,
): boolean => {
  const k = toBytes(key);
  const d = toBytes(data);
  const s = toBytes(sig);
  const nv = nativeFor("hmacSha256Verify");
  if (nv) return nv.hmacSha256Verify(k, d, s);
  return ctEqual(hmacSha256Bytes(k, d), s);
};

// ── Signed cookies ──────────────────────────────────────────────

export const signCookie = (value: string, secret: string | Uint8Array): string => {
  const s = toBytes(secret);
  const nv = nativeFor("signCookie");
  if (nv) return fromBytes(nv.signCookie(toBytes(value), s));
  return signCookieFallback(value, s);
};

/** `value.<lowercase-hex(HMAC-SHA256(secret, value))>`. */
export const signCookieFallback = (value: string, secret: Uint8Array): string => {
  const sig = hmacSha256Bytes(secret, toBytes(value));
  return `${value}.${hexEncode(sig)}`;
};

export const verifyCookie = (signed: string, secret: string | Uint8Array): string | null => {
  const s = toBytes(secret);
  const nv = nativeFor("verifyCookie");
  if (nv) {
    const result = nv.verifyCookie(toBytes(signed), s);
    return result ? fromBytes(result) : null;
  }
  return verifyCookieFallback(signed, s);
};

/** Verify a signed cookie; returns the value without its signature. */
export const verifyCookieFallback = (signed: string, secret: Uint8Array): string | null => {
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const sigHex = signed.slice(dot + 1);
  if (sigHex.length !== 64) return null;
  const sig = hexDecode(sigHex);
  if (!sig) return null;
  const expected = hmacSha256Bytes(secret, toBytes(value));
  return ctEqual(expected, sig) ? value : null;
};

// ── CSRF ────────────────────────────────────────────────────────

export const csrfToken = (secret: string | Uint8Array): string => {
  const s = toBytes(secret);
  const nv = nativeFor("csrfToken");
  if (nv) return fromBytes(nv.csrfToken(s));
  return csrfTokenFallback(s);
};

/** `<64-hex(random)>.<64-hex(HMAC-SHA256(secret, rnd_hex))>`. */
export const csrfTokenFallback = (secret: Uint8Array): string => {
  const rndHex = hexEncode(randomBytes(32));
  const sig = hexEncode(hmacSha256Bytes(secret, toBytes(rndHex)));
  return `${rndHex}.${sig}`;
};

export const csrfVerify = (token: string, secret: string | Uint8Array): boolean => {
  const s = toBytes(secret);
  const nv = nativeFor("csrfVerify");
  if (nv) return nv.csrfVerify(toBytes(token), s);
  return csrfVerifyFallback(token, s);
};

export const csrfVerifyFallback = (token: string, secret: Uint8Array): boolean => {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const rndHex = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  if (rndHex.length !== 64 || sigHex.length !== 64) return false;
  const sig = hexDecode(sigHex);
  if (!sig) return false;
  const expected = hmacSha256Bytes(secret, toBytes(rndHex));
  return ctEqual(expected, sig);
};

// ── JWT (HS256) ─────────────────────────────────────────────────

export const jwtSign = (
  claims: unknown,
  secret: string | Uint8Array,
  options: JwtSignOptions = {},
): string => {
  const s = toBytes(secret);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? null;
  const nv = nativeFor("jwtSign");
  if (nv) return fromBytes(nv.jwtSign(claims, s, ttl, now));
  return jwtSignFallback(claims, s, ttl, now);
};

/** HS256 compact token; injects `iat`/`exp` when `ttlSeconds > 0` (unless present). */
export const jwtSignFallback = (
  claims: unknown,
  secret: Uint8Array,
  ttlSeconds: number | null,
  nowSeconds: number,
): string => {
  let payload: unknown = claims;
  if (
    claims != null &&
    typeof claims === "object" &&
    !Array.isArray(claims) &&
    ttlSeconds != null &&
    ttlSeconds > 0
  ) {
    const obj: Record<string, unknown> = { ...(claims as Record<string, unknown>) };
    if (!("iat" in obj)) obj.iat = nowSeconds;
    if (!("exp" in obj)) obj.exp = nowSeconds + ttlSeconds;
    payload = obj;
  }
  const headerB64 = b64urlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payloadB64 = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signing = `${headerB64}.${payloadB64}`;
  const sig = b64urlEncode(hmacSha256Bytes(secret, toBytes(signing)));
  return `${signing}.${sig}`;
};

export const jwtVerify = (
  token: string,
  secret: string | Uint8Array,
  options: JwtVerifyOptions = {},
): unknown | null => {
  const s = toBytes(secret);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const nv = nativeFor("jwtVerify");
  if (nv) {
    const result = nv.jwtVerify(toBytes(token), s, now);
    return result ?? null;
  }
  return jwtVerifyFallback(token, s, now);
};

/** HS256 verify: signature (constant-time) + `alg` allowlist + time claims. */
export const jwtVerifyFallback = (
  token: string,
  secret: Uint8Array,
  nowSeconds: number,
): unknown | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;

  const headerJson = b64urlDecode(headerB64);
  if (!headerJson) return null;
  let header: { alg?: unknown };
  try {
    header = JSON.parse(fromBytes(headerJson)) as { alg?: unknown };
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const signing = `${headerB64}.${payloadB64}`;
  const expected = hmacSha256Bytes(secret, toBytes(signing));
  const provided = b64urlDecode(sigB64);
  if (!provided || provided.length !== expected.length || !ctEqual(expected, provided)) {
    return null;
  }

  const payloadJson = b64urlDecode(payloadB64);
  if (!payloadJson) return null;
  let value: unknown;
  try {
    value = JSON.parse(fromBytes(payloadJson));
  } catch {
    return null;
  }

  if (value != null && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const exp = typeof v.exp === "number" ? v.exp : undefined;
    const nbf = typeof v.nbf === "number" ? v.nbf : undefined;
    const iat = typeof v.iat === "number" ? v.iat : undefined;
    if (exp != null && nowSeconds >= exp) return null;
    if (nbf != null && nowSeconds < nbf) return null;
    if (iat != null && nowSeconds < iat - IAT_LEEWAY_SECONDS) return null;
  }

  return value;
};

// ── Random tokens / passwords ───────────────────────────────────

const MAX_TOKEN_BYTES = 16 * 1024 * 1024;

export const randomToken = (byteLen: number): string => {
  // Native returns the token as hex-string BYTES (not raw random bytes).
  const nv = nativeFor("randomToken");
  if (nv) return fromBytes(nv.randomToken(byteLen));
  return randomTokenFallback(byteLen);
};

/** Hex of `byteLen` CSPRNG bytes (2× the length in characters). */
export const randomTokenFallback = (byteLen: number): string => {
  const len = Math.max(0, Math.floor(byteLen));
  if (len > MAX_TOKEN_BYTES) {
    throw new Error(`random_token: byte_len ${byteLen} exceeds max ${MAX_TOKEN_BYTES}`);
  }
  return hexEncode(randomBytes(len));
};

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/**
 * Hash a password. Native → argon2id PHC string; fallback → `$scrypt$` PHC
 * string. `verifyPassword` dispatches on the PHC prefix so hashes produced
 * on either path verify regardless of native availability.
 */
export const passwordHash = (
  password: string,
  salt: string | Uint8Array,
  options: PasswordHashOptions = {},
): string => {
  const p = toBytes(password);
  const s = toBytes(salt);
  const nv = nativeFor("passwordHash");
  if (nv) {
    const opts =
      options.mCost != null ||
      options.tCost != null ||
      options.pCost != null ||
      options.outLen != null
        ? options
        : null;
    return fromBytes(nv.passwordHash(p, s, opts));
  }
  return passwordHashScrypt(p, s);
};

export const passwordVerify = (password: string, phc: string): boolean => {
  if (phc.startsWith("$scrypt$")) return passwordVerifyScrypt(toBytes(password), phc);
  const nv = nativeFor("passwordVerify");
  if (nv) return nv.passwordVerify(toBytes(password), toBytes(phc));
  return false;
};

const passwordHashScrypt = (password: Uint8Array, salt: Uint8Array): string => {
  const derived = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `$scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${hexEncode(salt)}$${hexEncode(derived)}`;
};

const passwordVerifyScrypt = (password: Uint8Array, phc: string): boolean => {
  const rest = phc.slice("$scrypt$".length);
  const sep1 = rest.indexOf("$");
  if (sep1 < 0) return false;
  const sep2 = rest.indexOf("$", sep1 + 1);
  if (sep2 < 0) return false;
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(rest.slice(0, sep1));
  if (!m) return false;
  const salt = hexDecode(rest.slice(sep1 + 1, sep2));
  const hash = hexDecode(rest.slice(sep2 + 1));
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, hash.length, {
    N: Number(m[1]),
    r: Number(m[2]),
    p: Number(m[3]),
  });
  return ctEqual(derived, hash);
};

// ── AEAD (AES-256-GCM / ChaCha20-Poly1305) ──────────────────────

export const aeadEncrypt = (
  key: string | Uint8Array,
  nonce: string | Uint8Array,
  plaintext: string | Uint8Array,
  algorithm?: string | null,
): Uint8Array => {
  const k = toBytes(key);
  const n = toBytes(nonce);
  const p = toBytes(plaintext);
  const nv = nativeFor("aeadEncrypt");
  if (nv) return toPlain(nv.aeadEncrypt(k, n, p, algorithm ?? null));
  return aeadEncryptFallback(k, n, p, algorithm ?? null);
};

/** AES-256-GCM encrypt → ciphertext ‖ 16-byte tag. */
export const aeadEncryptFallback = (
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  algorithm?: string | null,
): Uint8Array => {
  if (algorithm != null && algorithm !== "aes-256-gcm") {
    throw new Error(`aead: unsupported algorithm '${algorithm}'`);
  }
  if (key.length !== 32) throw new Error("aead: key must be 32 bytes");
  if (nonce.length !== 12) throw new Error("aead: nonce must be 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([enc, cipher.getAuthTag()]));
};

export const aeadDecrypt = (
  key: string | Uint8Array,
  nonce: string | Uint8Array,
  ciphertext: string | Uint8Array,
  algorithm?: string | null,
): Uint8Array | null => {
  const k = toBytes(key);
  const n = toBytes(nonce);
  const c = toBytes(ciphertext);
  const nv = nativeFor("aeadDecrypt");
  if (nv) {
    const result = nv.aeadDecrypt(k, n, c, algorithm ?? null);
    return result ? new Uint8Array(result) : null;
  }
  return aeadDecryptFallback(k, n, c, algorithm ?? null);
};

/** AES-256-GCM decrypt; returns `null` on auth failure or malformed input. */
export const aeadDecryptFallback = (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  algorithm?: string | null,
): Uint8Array | null => {
  if (algorithm != null && algorithm !== "aes-256-gcm") return null;
  if (key.length !== 32 || nonce.length !== 12 || ciphertext.length < 16) return null;
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    return null;
  }
};

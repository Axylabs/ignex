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
import { createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { createRequire } from "node:module";
import { bunHmacSha256 } from "./bun";
import { isFfiActive } from "./ffi";
import { getAddonPath } from "./loader";
import { nativeFor } from "./runtime";
import { reportDegradation } from "./telemetry";
import {
  b64urlDecode,
  b64urlEncode,
  ctEqual,
  decoder,
  encoder,
  fromBytes,
  hexDecode,
  hexEncode,
  hmacSha256Bytes,
  toBytes,
  toPlain,
  toStr,
} from "./util";

/** Options for {@link jwtSign} (HS256). */
export interface JwtSignOptions {
  /** Time-to-live in seconds (injects `iat`/`exp` when positive). */
  ttlSeconds?: number;
  /** Current epoch seconds (defaults to `Date.now() / 1000`). */
  nowSeconds?: number;
}

/** Options for {@link jwtVerify} (HS256). */
export interface JwtVerifyOptions {
  /** Current epoch seconds (defaults to `Date.now() / 1000`). */
  nowSeconds?: number;
  /**
   * Reject tokens without a numeric `exp` claim. Default `true` — a token
   * that never expires turns any leak into a permanent compromise, so
   * non-expiring tokens must be an EXPLICIT decision (`requireExp: false`),
   * never a silent consequence of omitting `ttlSeconds` at sign time.
   */
  requireExp?: boolean;
}

/**
 * Enforce {@link JwtVerifyOptions.requireExp} on a successful verify result.
 * Wrapper-level (applies identically to the native addon and the pure-TS
 * fallback) because the addon's Rust-side time checks treat a missing `exp`
 * as valid — tightening there would be a cross-repo ABI change.
 */
const enforceRequireExp = <T>(claims: T, requireExp: boolean): T | null => {
  if (!requireExp) return claims;
  if (claims == null || typeof claims !== "object") return null;
  return typeof (claims as Record<string, unknown>).exp === "number" ? claims : null;
};

/** Options controlling argon2id/scrypt cost for {@link passwordHash}. */
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

/** HMAC-SHA256 digest of `data` under `key` (64 lowercase-hex, native contract). */
export const hmacSha256 = (key: string | Uint8Array, data: string | Uint8Array): Uint8Array => {
  const k = toBytes(key);
  const d = toBytes(data);
  const nv = nativeFor("hmacSha256");
  if (nv) return toPlain(nv.hmacSha256(k, d));
  // Under Bun, `Bun.CryptoHasher` is mildly faster than Rust for scalar HMAC.
  if (bunHmacSha256) return bunHmacSha256(k, d);
  // Node pure-TS: hex-encode the raw digest so ALL backends (native / Bun /
  // Node) return the SAME 64-hex contract — sign→verify stays byte-compatible.
  return encoder.encode(hexEncode(hmacSha256Bytes(k, d)));
};

/** Constant-time verify of an HMAC-SHA256 signature. */
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
  // Pure-TS fallback — MUST match the native contract: `hmacSha256`/the addon
  // produce/expect a 64 lowercase-hex signature, so compare the hex-encoded
  // digest (a raw 32-byte sig is rejected, exactly like native). Previously
  // this compared the raw digest, so pure-JS sign→verify was broken.
  return ctEqual(encoder.encode(hexEncode(hmacSha256Bytes(k, d))), s);
};

// ── Signed cookies ──────────────────────────────────────────────

/** Sign a cookie value → `value.<hex(HMAC-SHA256(secret, value))>`. */
export const signCookie = (value: string, secret: string | Uint8Array): string => {
  const s = toBytes(secret);
  const nv = nativeFor("signCookie");
  if (nv) return toStr(nv.signCookie(toBytes(value), s));
  return signCookieFallback(value, s);
};

/** `value.<lowercase-hex(HMAC-SHA256(secret, value))>`. */
export const signCookieFallback = (value: string, secret: Uint8Array): string => {
  const sig = hmacSha256Bytes(secret, toBytes(value));
  return `${value}.${hexEncode(sig)}`;
};

/** Verify a signed cookie; returns the value without its signature, or `null`. */
export const verifyCookie = (signed: string, secret: string | Uint8Array): string | null => {
  const s = toBytes(secret);
  const nv = nativeFor("verifyCookie");
  if (nv) {
    const result = nv.verifyCookie(toBytes(signed), s);
    // `!= null` (not truthy): a successful verify of an EMPTY value yields "".
    return result != null ? toStr(result) : null;
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

/** Generate a CSRF token (`<64-hex(random)>.<64-hex(sig)>`). */
export const csrfToken = (secret: string | Uint8Array): string => {
  const s = toBytes(secret);
  const nv = nativeFor("csrfToken");
  if (nv) return toStr(nv.csrfToken(s));
  return csrfTokenFallback(s);
};

/** `<64-hex(random)>.<64-hex(HMAC-SHA256(secret, rnd_hex))>`. */
export const csrfTokenFallback = (secret: Uint8Array): string => {
  // `crypto.getRandomValues` (webcrypto) is the fast, portable CSPRNG — native
  // in Bun (~87x vs `node:crypto` randomBytes for small buffers — see
  // docs/bun-internals.md) and available in Node too.
  const rnd = new Uint8Array(32);
  crypto.getRandomValues(rnd);
  const rndHex = hexEncode(rnd);
  const sig = hexEncode(hmacSha256Bytes(secret, toBytes(rndHex)));
  return `${rndHex}.${sig}`;
};

/** Constant-time verify of a CSRF token. */
export const csrfVerify = (token: string | Uint8Array, secret: string | Uint8Array): boolean => {
  const s = toBytes(secret);
  const nv = nativeFor("csrfVerify");
  if (nv) return nv.csrfVerify(toBytes(token), s);
  return csrfVerifyFallback(fromBytes(toBytes(token)), s);
};

/** Pure-TS fallback for {@link csrfVerify} (identical behavior). */
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

/**
 * Sign a payload as an HS256 compact JWT; injects `iat`/`exp` when
 * `ttlSeconds > 0`. When native is active, claims are pre-serialized to bytes
 * and passed to castrum's `jwtSignBytes` — its object path (`jwtSign`)
 * napi-marshals the JS value into a `serde_json::Value`, which dominates the
 * sign cost. The byte path also avoids a second stringify when the fallback is
 * used (claims are serialized exactly once here).
 */
export const jwtSign = (
  claims: unknown,
  secret: string | Uint8Array,
  options: JwtSignOptions = {},
): string => {
  const s = toBytes(secret);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? null;
  const nv = nativeFor("jwtSign");
  if (nv) {
    const json = JSON.stringify(claims);
    // `JSON.stringify(undefined/function/symbol)` → `undefined`; fall back to
    // the object path in that edge case to preserve prior native behavior.
    if (json !== undefined && typeof nv.jwtSignBytes === "function") {
      return toStr(nv.jwtSignBytes(encoder.encode(json), s, ttl, now));
    }
    return fromBytes(nv.jwtSign(claims, s, ttl, now));
  }
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

/** Verify and decode an HS256 compact JWT; returns `null` on any failure. */
export const jwtVerify = (
  token: string,
  secret: string | Uint8Array,
  options: JwtVerifyOptions = {},
): unknown | null => {
  const s = toBytes(secret);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const requireExp = options.requireExp ?? true;
  const nv = nativeFor("jwtVerify");
  if (nv) {
    const result = nv.jwtVerify(toBytes(token), s, now);
    return enforceRequireExp(result ?? null, requireExp);
  }
  return enforceRequireExp(jwtVerifyFallback(token, s, now), requireExp);
};

/** HS256 verify: signature (constant-time) + `alg` allowlist + time claims. */
export const jwtVerifyFallback = (
  token: string,
  secret: Uint8Array,
  nowSeconds: number,
): unknown | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

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

/** Generate a hex-encoded CSPRNG token of `byteLen` bytes (2× the length in characters). */
export const randomToken = (byteLen: number): string => {
  // Native returns the token as hex-string (cstring) or hex-string bytes.
  const nv = nativeFor("randomToken");
  if (nv) return toStr(nv.randomToken(byteLen));
  return randomTokenFallback(byteLen);
};

/** Hex of `byteLen` CSPRNG bytes (2× the length in characters). */
export const randomTokenFallback = (byteLen: number): string => {
  const len = Math.max(0, Math.floor(byteLen));
  if (len > MAX_TOKEN_BYTES) {
    throw new Error(`random_token: byte_len ${byteLen} exceeds max ${MAX_TOKEN_BYTES}`);
  }
  // `crypto.getRandomValues` (webcrypto) is the fast, portable CSPRNG — native
  // in Bun and Node — and beats the Rust addon for token-sized output.
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return hexEncode(bytes);
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
  return passwordHashFallback(p, s);
};

/**
 * The PHC algorithm of a stored hash: `"argon2id"`, `"scrypt"`, or `"unknown"`
 * (malformed / foreign format). Lets callers detect a native↔fallback backend
 * split before it turns into silent login failures.
 */
export const passwordHashAlgorithm = (phc: string): "argon2id" | "scrypt" | "unknown" => {
  if (phc.startsWith("$scrypt$")) return "scrypt";
  if (phc.startsWith("$argon2id$") || phc.startsWith("$argon2i$") || phc.startsWith("$argon2d$"))
    return "argon2id";
  return "unknown";
};

/** True when an argon2id PHC can actually be verified on THIS backend. */
export const canVerifyPasswordHash = (phc: string): boolean =>
  passwordHashAlgorithm(phc) !== "argon2id" || nativeFor("passwordVerify") != null;

/** Verify a password against a PHC string (dispatches argon2id ↔ scrypt by prefix). */
export const passwordVerify = (password: string, phc: string): boolean => {
  if (phc.startsWith("$scrypt$")) return passwordVerifyFallback(toBytes(password), phc);
  const nv = nativeFor("passwordVerify");
  if (nv) return nv.passwordVerify(toBytes(password), toBytes(phc));
  // Backend downgrade (hash created with the addon, verifying without it):
  // fail closed but SAY SO — previously this returned `false` silently and
  // every login failed with zero diagnostics after `IGNEX_NATIVE=off`.
  reportDegradation(
    "unsupported",
    "passwordVerify",
    "argon2id hash cannot be verified without the native addon (IGNEX_NATIVE=off) — " +
      "re-hash the credential on the current backend or re-enable the addon; " +
      "use passwordHashAlgorithm()/canVerifyPasswordHash() to detect this proactively",
  );
  return false;
};

/** Pure-TS password hash (`$scrypt$` PHC) used when native is unavailable. */
export const passwordHashFallback = (
  password: Uint8Array,
  salt: Uint8Array,
  _options?: PasswordHashOptions,
): string => passwordHashScrypt(password, salt);

/** Pure-TS password verify (`$scrypt$` PHC) used when native is unavailable. */
export const passwordVerifyFallback = (password: Uint8Array, phc: string): boolean =>
  passwordVerifyScrypt(password, phc);

const passwordHashScrypt = (password: Uint8Array, salt: Uint8Array): string => {
  const derived = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `$scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${hexEncode(salt)}$${hexEncode(derived)}`;
};

/**
 * Upper bounds for cost parameters parsed from a PHC string before they reach
 * `scryptSync`. Verification may run on ATTACKER-SHAPED strings (import
 * tools, admin resets, user-supplied hashes), and scrypt memory grows as
 * `128 * N * r` bytes — an unbounded `N=2^27` would exhaust the process.
 * Caps are far above the hash defaults below (any legitimately stronger
 * hash within these bounds still verifies); anything beyond fails closed.
 */
const SCRYPT_MAX_N = 1 << 20; // 2^20 → 128 MiB at r=8
const SCRYPT_MAX_R = 32;
const SCRYPT_MAX_P = 8;
const SCRYPT_MAX_KEYLEN = 1024;

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
  if (hash.length > SCRYPT_MAX_KEYLEN) return false;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  // Fail closed on attacker-inflated costs instead of allocating them.
  if (
    N < 2 ||
    (N & (N - 1)) !== 0 ||
    r < 1 ||
    p < 1 ||
    N > SCRYPT_MAX_N ||
    r > SCRYPT_MAX_R ||
    p > SCRYPT_MAX_P
  ) {
    return false;
  }
  const derived = scryptSync(password, salt, hash.length, { N, r, p });
  return ctEqual(derived, hash);
};

// ── AEAD (AES-256-GCM / ChaCha20-Poly1305) ──────────────────────

/** AEAD encrypt (AES-256-GCM) → ciphertext ‖ 16-byte tag. */
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

/** AEAD decrypt; returns `null` on auth failure or malformed input. */
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

// ── Session envelope (fused JSON + HMAC) ────────────────────────────

/** Lazy dedicated C-ABI surface for the two session symbols (null when absent). */
let sessionFfi:
  | {
      seal(id: string, dataJson: string, exp: number, secret: string): string | null;
      open(token: string, secret: string, out: Uint8Array, outLen: number): number;
    }
  | null
  | undefined;

const getSessionFfi = (): {
  seal(id: string, dataJson: string, exp: number, secret: string): string | null;
  open(token: string, secret: string, out: Uint8Array, outLen: number): number;
} | null => {
  if (sessionFfi !== undefined) return sessionFfi;
  sessionFfi = null;
  if (!isFfiActive()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const require_ = createRequire(import.meta.url);
    const { dlopen } = require_("bun:ffi") as {
      dlopen: (
        p: string,
        syms: Record<string, { args: readonly string[]; returns: string }>,
      ) => { symbols: Record<string, (...a: unknown[]) => unknown> };
    };
    const addonPath = getAddonPath();
    if (!addonPath) return null;
    const { symbols } = dlopen(addonPath, {
      castrum_session_seal: {
        args: ["cstring", "cstring", "i64", "cstring"],
        returns: "cstring",
      },
      castrum_session_open: {
        args: ["cstring", "cstring", "ptr", "usize"],
        returns: "usize",
      },
    });
    if (
      typeof symbols.castrum_session_seal !== "function" ||
      typeof symbols.castrum_session_open !== "function"
    ) {
      return null;
    }
    const sealF = symbols.castrum_session_seal as (...a: unknown[]) => string | null;
    const openF = symbols.castrum_session_open as (...a: unknown[]) => number;
    // Bind-time round-trip self-test (the primary C-ABI surface has one; this
    // lazy surface previously had NONE — a broken bind or ABI drift would
    // surface as sessions that never validate at request time). Probe a fixed
    // envelope seal→open and require exact field recovery; any mismatch
    // degrades to the JS path (signCookie/verifyCookie) with a report.
    if (!sessionBindSelfTest(sealF, openF)) {
      reportDegradation(
        "self-test-failed",
        "sessionSeal",
        "session seal→open bind self-test failed — fused session ops disabled (JS path owns them)",
      );
      return null;
    }
    sessionFfi = {
      seal: (id, dataJson, exp, secret) => sealF(id, dataJson, BigInt(exp), secret),
      open: (token, secret, out, outLen) => Number(openF(token, secret, out, outLen)),
    };
    return sessionFfi;
  } catch {
    return null;
  }
};

/** Fixed probe payload for the session bind self-test. */
const SESSION_PROBE = {
  id: "__ignex_bind_probe__",
  dataJson: '{"v":1}',
  exp: 4_102_444_800,
} as const;
const SESSION_PROBE_SECRET = "__ignex_session_selftest_secret__";

/** Seal→open round-trip over the raw bound symbols; true iff fields recover exactly. */
function sessionBindSelfTest(
  sealF: (...a: unknown[]) => string | null,
  openF: (...a: unknown[]) => number,
): boolean {
  try {
    const token = sealF(
      SESSION_PROBE.id,
      SESSION_PROBE.dataJson,
      BigInt(SESSION_PROBE.exp),
      SESSION_PROBE_SECRET,
    );
    if (typeof token !== "string" || token.length === 0) return false;
    let out = new Uint8Array(512);
    let w = Number(openF(token, SESSION_PROBE_SECRET, out, out.length));
    if (w > out.length) {
      out = new Uint8Array(w);
      w = Number(openF(token, SESSION_PROBE_SECRET, out, out.length));
    }
    const decoded = decodeSessionWire(out, w);
    return (
      decoded !== null &&
      decoded.id === SESSION_PROBE.id &&
      decoded.exp === SESSION_PROBE.exp &&
      decoded.dataJson === SESSION_PROBE.dataJson
    );
  } catch {
    return false;
  }
}

/**
 * Decode the session-open wire (`[u8 ok][i64 exp][u32 idLen][id][u32
 * dataLen][data]`) under FULL bounds validation — every length is checked
 * against the written byte count before any subarray. Returns `null` on a
 * short/lying wire instead of decoding adjacent memory.
 */
function decodeSessionWire(
  out: Uint8Array,
  w: number,
): { id: string; exp: number; dataJson: string } | null {
  // Minimum wire: status(1) + exp(8) + idLen(4) + dataLen(4).
  if (w < 17 || out[0] !== 1 || w > out.byteLength) return null;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const exp = Number(dv.getBigInt64(1, true));
  const idLen = dv.getUint32(9, true);
  if (13 + idLen + 4 > w) return null;
  const id = decoder.decode(out.subarray(13, 13 + idLen));
  const dataLen = dv.getUint32(13 + idLen, true);
  const dataStart = 17 + idLen;
  if (dataLen > w - dataStart) return null;
  const dataJson = decoder.decode(out.subarray(dataStart, dataStart + dataLen));
  return { id, exp, dataJson };
}

/**
 * Fused session seal: builds `{"id":"…","data":<dataJson>,"exp":exp}` and
 * HMAC-signs it into the `payload.<hex>` cookie token in ONE crossing —
 * replaces `signCookie(JSON.stringify(envelope), secret)` (which paid a full
 * envelope stringify + a second transcode). `dataJson` is embedded verbatim.
 *
 * @returns The sealed token, or `null` when ffi is unavailable → callers use
 *   `signCookie(JSON.stringify(envelope), secret)`.
 */
export const sessionSeal = (
  id: string,
  dataJson: string,
  expSecs: number,
  secret: string | Uint8Array,
): string | null => {
  const ffiS = getSessionFfi();
  if (!ffiS) return null;
  const sStr = typeof secret === "string" ? secret : decoder.decode(secret);
  return ffiS.seal(id, dataJson, expSecs, sStr);
};

/**
 * Fused session open: verify + extract `{ id, exp, dataJson }` in one
 * crossing. `dataJson` is raw JSON text — parse in JS only when the caller
 * needs the object. `null` on bad signature / malformed / ffi unavailable.
 *
 * The wire is decoded under full bounds validation ({@link decodeSessionWire})
 * — a short or lying write returns `null`, never a decode of adjacent memory.
 */
export const sessionOpen = (
  token: string,
  secret: string | Uint8Array,
): { id: string; exp: number; dataJson: string } | null => {
  const ffiS = getSessionFfi();
  if (!ffiS) return null;
  const sStr = typeof secret === "string" ? secret : decoder.decode(secret);
  let out = new Uint8Array(512);
  let w = ffiS.open(token, sStr, out, out.length);
  if (w > out.length) {
    out = new Uint8Array(w);
    w = ffiS.open(token, sStr, out, out.length);
  }
  if (w === 0) return null;
  return decodeSessionWire(out, w);
};

/**
 * Ed25519 + EdDSA JWT primitives — backed by the Rust addon (castrum) when
 * available and falling back to byte-compatible pure-TS implementations (Node
 * `crypto` ed25519). Formats are locked to the native addon (RFC 8410):
 *
 * - private key: PKCS#8 v1 DER, base64url (`JWT_PRIVATE_KEY` in `.env`)
 * - public key:  SPKI DER, base64url (`JWT_PUBLIC_KEY` in `.env`)
 * - JWT:         compact EdDSA token (`alg: "EdDSA"`) with `iat`/`exp`
 *
 * Both transports (NAPI + C-ABI `bun:ffi`) produce the SAME byte formats as
 * the pure-TS fallback, so keys/tokens round-trip across every backend.
 */

import type { KeyObject } from "node:crypto";
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from "node:crypto";
import { nativeFor } from "./runtime";
import { b64urlDecode, b64urlEncode, encoder, fromBytes, toBytes, toPlain, toStr } from "./util";

/** Options for {@link jwtSignEdDsa} (EdDSA). Distinct from the HS256
 * `JwtSignOptions` in `./crypto` (same shape). */
export interface EdDsaJwtSignOptions {
  /** Time-to-live in seconds (injects `iat`/`exp` when positive). */
  ttlSeconds?: number;
  /** Current epoch seconds (defaults to `Date.now() / 1000`). */
  nowSeconds?: number;
}

/** Options for {@link jwtVerifyEdDsa} (EdDSA). Distinct from the HS256
 * `JwtVerifyOptions` in `./crypto` (same shape). */
export interface EdDsaJwtVerifyOptions {
  /** Current epoch seconds (defaults to `Date.now() / 1000`). */
  nowSeconds?: number;
  /**
   * Reject tokens without a numeric `exp` claim. Default `true` — mirrors
   * HS256 `jwtVerify`: non-expiring tokens must be an explicit opt-out,
   * never a silent consequence of omitting `ttlSeconds` at sign time.
   */
  requireExp?: boolean;
}

/** Clock-skew leeway (seconds) for the `iat` claim — matches HS256 + native. */
const IAT_LEEWAY_SECONDS = 60;

/**
 * Enforce `requireExp` on a successful EdDSA verify result — same contract as
 * the HS256 helper in `./crypto` (wrapper-level so native and fallback agree).
 */
const enforceRequireExp = <T>(claims: T, requireExp: boolean): T | null => {
  if (!requireExp) return claims;
  if (claims == null || typeof claims !== "object") return null;
  return typeof (claims as Record<string, unknown>).exp === "number" ? claims : null;
};

/** An Ed25519 keypair serialized for `.env` storage (base64url DER strings). */
export interface Ed25519Keypair {
  /** PKCS#8 v1 DER private key, base64url. */
  readonly privateKey: string;
  /** SPKI DER public key, base64url. */
  readonly publicKey: string;
}

/**
 * Normalize a key to its raw DER bytes. Accepts a base64url DER string (the
 * `.env`/NAPI contract) or raw DER `Uint8Array`; anything else → empty bytes
 * (native/fallback fail closed on an invalid key).
 */
const derBytes = (key: string | Uint8Array): Uint8Array =>
  typeof key === "string" ? (b64urlDecode(key) ?? new Uint8Array(0)) : toBytes(key);

// ── Keypair generation ──────────────────────────────────────────

/**
 * Generate an Ed25519 keypair → `{ privateKey, publicKey }` as base64url DER
 * strings, ready to persist in `.env`. Native-first (castrum); pure-TS Node
 * `crypto` fallback produces byte-identical PKCS#8/SPKI DER.
 */
export const generateEd25519Keypair = (): Ed25519Keypair => {
  const nv = nativeFor("generateEd25519Keypair");
  if (nv) {
    const pair = nv.generateEd25519Keypair();
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  }
  return generateEd25519KeypairFallback();
};

/** Pure-TS keypair generation — byte-identical to the native PKCS#8/SPKI. */
export const generateEd25519KeypairFallback = (): Ed25519Keypair => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: b64urlEncode(
      new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }) as Buffer),
    ),
    publicKey: b64urlEncode(
      new Uint8Array(publicKey.export({ type: "spki", format: "der" }) as Buffer),
    ),
  };
};

// ── Raw Ed25519 sign/verify ─────────────────────────────────────

/** Sign `msg` with an Ed25519 private key (PKCS#8 DER) → 64-byte signature. */
export const ed25519Sign = (
  msg: string | Uint8Array,
  privateKey: string | Uint8Array,
): Uint8Array => {
  const m = toBytes(msg);
  const key = derBytes(privateKey);
  const nv = nativeFor("ed25519Sign");
  if (nv) return toPlain(nv.ed25519Sign(m, key));
  return ed25519SignFallback(key, m);
};

/** Pure-TS sign — one-shot `crypto.sign(null, ...)` (Ed25519 has no prehash). */
export const ed25519SignFallback = (privateKey: Uint8Array, msg: Uint8Array): Uint8Array => {
  const key = createPrivateKey({ key: Buffer.from(privateKey), format: "der", type: "pkcs8" });
  return new Uint8Array(cryptoSign(null, msg, key) as Buffer);
};

/** Verify a 64-byte Ed25519 signature with an SPKI DER (or raw) public key. */
export const ed25519Verify = (
  msg: string | Uint8Array,
  signature: string | Uint8Array,
  publicKey: string | Uint8Array,
): boolean => {
  const m = toBytes(msg);
  const sig = toBytes(signature);
  const key = derBytes(publicKey);
  const nv = nativeFor("ed25519Verify");
  if (nv) return nv.ed25519Verify(m, sig, key);
  return ed25519VerifyFallback(key, m, sig);
};

/** Pure-TS verify — one-shot `crypto.verify(null, ...)`; false on any failure. */
export const ed25519VerifyFallback = (
  publicKey: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array,
): boolean => {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey), format: "der", type: "spki" });
    return cryptoVerify(null, msg, key, sig);
  } catch {
    return false;
  }
};

// ── EdDSA JWT (compact token, `alg: "EdDSA"`) ───────────────────

/**
 * Sign a payload as an EdDSA (Ed25519) compact JWT; injects `iat`/`exp` when
 * `ttlSeconds > 0`. Claims are pre-serialized to bytes and passed to castrum's
 * `jwtSignEddsa` byte path (no napi `serde_json::Value` DOM marshal).
 */
export const jwtSignEdDsa = (
  claims: unknown,
  privateKey: string | Uint8Array,
  options: EdDsaJwtSignOptions = {},
): string => {
  const key = derBytes(privateKey);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? null;
  const nv = nativeFor("jwtSignEdDsa");
  if (nv) {
    const json = JSON.stringify(claims);
    // `JSON.stringify(undefined/function/symbol)` → `undefined`; the fallback
    // handles that edge the same way as the HS256 path.
    if (json !== undefined) {
      return toStr(nv.jwtSignEddsa(encoder.encode(json), key, ttl, now));
    }
  }
  return jwtSignEdDsaFallback(claims, key, ttl, now);
};

/** Pure-TS EdDSA sign — byte-compatible with the native `alg: "EdDSA"` token. */
export const jwtSignEdDsaFallback = (
  claims: unknown,
  privateKey: Uint8Array,
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
  const headerB64 = b64urlEncode(encoder.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const payloadB64 = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = createPrivateKey({ key: Buffer.from(privateKey), format: "der", type: "pkcs8" });
  const sig = cryptoSign(null, encoder.encode(signingInput), key);
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig as Buffer))}`;
};

/**
 * Verify and decode an EdDSA (Ed25519) compact JWT; returns `null` on any
 * failure. Signature is verified with the SPKI public key (constant-time in
 * the native path), `alg` is allowlisted, and `exp`/`nbf`/`iat` are enforced.
 */
export const jwtVerifyEdDsa = (
  token: string | Uint8Array,
  publicKey: string | Uint8Array,
  options: EdDsaJwtVerifyOptions = {},
): unknown | null => {
  const key = derBytes(publicKey);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const requireExp = options.requireExp ?? true;
  const nv = nativeFor("jwtVerifyEdDsa");
  if (nv) {
    const result = nv.jwtVerifyEddsa(toBytes(token), key, now);
    return enforceRequireExp(result ?? null, requireExp);
  }
  return enforceRequireExp(jwtVerifyEdDsaFallback(toStr(toBytes(token)), key, now), requireExp);
};

/** Time-claim checks (`exp`/`nbf`/`iat`) for the EdDSA verify fallback. */
const checkTimeClaims = (value: unknown, nowSeconds: number): boolean => {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const exp = typeof v.exp === "number" ? v.exp : undefined;
  const nbf = typeof v.nbf === "number" ? v.nbf : undefined;
  const iat = typeof v.iat === "number" ? v.iat : undefined;
  if (exp != null && nowSeconds >= exp) return false;
  if (nbf != null && nowSeconds < nbf) return false;
  if (iat != null && nowSeconds < iat - IAT_LEEWAY_SECONDS) return false;
  return true;
};

/** Pure-TS EdDSA verify — signature + `alg` allowlist + time claims. */
export const jwtVerifyEdDsaFallback = (
  token: string,
  publicKey: Uint8Array,
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
  if (header.alg !== "EdDSA") return null;

  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = b64urlDecode(sigB64);
  if (!sig) return null;

  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(publicKey), format: "der", type: "spki" });
  } catch {
    return null;
  }
  let valid = false;
  try {
    valid = cryptoVerify(null, encoder.encode(signingInput), key, sig);
  } catch {
    valid = false;
  }
  if (!valid) return null;

  const payloadJson = b64urlDecode(payloadB64);
  if (!payloadJson) return null;
  let value: unknown;
  try {
    value = JSON.parse(fromBytes(payloadJson));
  } catch {
    return null;
  }

  if (value == null || typeof value !== "object") return value;
  return checkTimeClaims(value, nowSeconds) ? value : null;
};

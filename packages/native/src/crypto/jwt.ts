/**
 * @fileoverview HS256 compact JWT — sign (with `iat`/`exp` injection) and
 * verify (signature + `alg` allowlist + time claims), native-accelerated with
 * a byte-compatible pure-TS fallback.
 *
 * Extracted from the pre-split `crypto.ts` (move-only); the digest comes from
 * the shared `../util` helpers (not `./hmac`), re-exported by `./index`.
 */

import { nativeFor } from "../runtime";
import {
  b64urlDecode,
  b64urlEncode,
  ctEqual,
  encoder,
  fromBytes,
  hmacSha256Bytes,
  toBytes,
  toStr,
} from "../util";

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

/** Clock-skew leeway (seconds) for the `iat` claim — matches native. */
const IAT_LEEWAY_SECONDS = 60;

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

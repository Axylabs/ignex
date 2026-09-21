/**
 * @fileoverview Password hashing — argon2id PHC (native addon) with the
 * `$scrypt$` PHC pure-TS fallback (Node `scryptSync`), plus PHC algorithm
 * detection and fail-closed verify on a backend downgrade.
 *
 * Extracted from the pre-split `crypto.ts` (move-only); re-exported by
 * `./index`.
 */

import { scryptSync } from "node:crypto";
import { nativeFor } from "../runtime";
import { reportDegradation } from "../telemetry";
import { ctEqual, fromBytes, hexDecode, hexEncode, toBytes } from "../util";

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

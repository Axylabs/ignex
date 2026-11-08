/**
 * @fileoverview Portable password hashing — scrypt by default with optional
 * native Argon2id, plus off-thread async hash and verification.
 */

import { scrypt, scryptSync } from "node:crypto";
import { nativeFor } from "../runtime";
import { reportDegradation } from "../telemetry";
import { ctEqual, fromBytes, hexDecode, hexEncode, toBytes } from "../util";

/** Options controlling argon2id/scrypt cost for {@link passwordHash}. */
export interface PasswordHashOptions {
  /** Hash algorithm. Portable scrypt is the default; Argon2id requires castrum. */
  algorithm?: "scrypt" | "argon2id";
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
const SCRYPT_MAX_N = 1 << 20;
const SCRYPT_MAX_R = 32;
const SCRYPT_MAX_P = 8;
const SCRYPT_MAX_KEYLEN = 1024;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

const scryptParams = (phc: string): ScryptParams | null => {
  const rest = phc.slice("$scrypt$".length);
  const sep1 = rest.indexOf("$");
  if (sep1 < 0) return null;
  const sep2 = rest.indexOf("$", sep1 + 1);
  if (sep2 < 0) return null;
  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(rest.slice(0, sep1));
  if (!match) return null;
  const salt = hexDecode(rest.slice(sep1 + 1, sep2));
  const hash = hexDecode(rest.slice(sep2 + 1));
  if (!salt || !hash || hash.length > SCRYPT_MAX_KEYLEN) return null;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (
    N < 2 ||
    (N & (N - 1)) !== 0 ||
    r < 1 ||
    p < 1 ||
    N > SCRYPT_MAX_N ||
    r > SCRYPT_MAX_R ||
    p > SCRYPT_MAX_P
  ) {
    return null;
  }
  return { N, r, p, salt, hash };
};

const scryptAsync = (
  password: Uint8Array,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });

/** Hash with portable scrypt, or native Argon2id when explicitly requested. */
export const passwordHash = (
  password: string,
  salt: string | Uint8Array,
  options: PasswordHashOptions = {},
): string => {
  const p = toBytes(password);
  const s = toBytes(salt);
  if (options.algorithm === "argon2id") {
    const nv = nativeFor("passwordHash");
    if (!nv) throw new Error("Argon2id password hashing requires the castrum native addon");
    return fromBytes(nv.passwordHash(p, s, options));
  }
  return passwordHashFallback(p, s);
};

/** Hash scrypt off the event loop; explicit native Argon2id currently hashes synchronously. */
export const passwordHashAsync = async (
  password: string,
  salt: string | Uint8Array,
  options: PasswordHashOptions = {},
): Promise<string> => {
  if (options.algorithm === "argon2id") return passwordHash(password, salt, options);
  return passwordHashFallbackAsync(toBytes(password), toBytes(salt));
};

/** The PHC algorithm of a stored hash. */
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
): string => {
  const derived = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `$scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${hexEncode(salt)}$${hexEncode(derived)}`;
};

/** Off-thread pure-TS scrypt hash. */
export const passwordHashFallbackAsync = async (
  password: Uint8Array,
  salt: Uint8Array,
): Promise<string> => {
  const derived = await scryptAsync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `$scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${hexEncode(salt)}$${hexEncode(derived)}`;
};

/** Pure-TS password verify (`$scrypt$` PHC) used when native is unavailable. */
export const passwordVerifyFallback = (password: Uint8Array, phc: string): boolean => {
  const params = scryptParams(phc);
  if (!params) return false;
  const derived = scryptSync(password, params.salt, params.hash.length, params);
  return ctEqual(derived, params.hash);
};

/** Off-thread pure-TS scrypt verification with attacker-cost bounds. */
export const passwordVerifyFallbackAsync = async (
  password: Uint8Array,
  phc: string,
): Promise<boolean> => {
  const params = scryptParams(phc);
  if (!params) return false;
  const derived = await scryptAsync(password, params.salt, params.hash.length, params);
  return ctEqual(derived, params.hash);
};

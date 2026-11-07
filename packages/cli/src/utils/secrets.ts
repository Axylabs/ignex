/**
 * @fileoverview Random secret generation for generated env/compose files.
 *
 * Every secret the CLI writes — compose credentials, `.env` app secrets,
 * `.env.docker` placeholders — comes from here so strength and encoding stay
 * uniform: base64url for values that ride in env files without quoting, hex
 * for secrets that should match the `openssl rand -hex 32` shape the session
 * manager's error hints recommend.
 */
import { secureRandomBytes } from "./bun-compat.js";

/**
 * Generate a URL-safe random secret (base64url, no padding).
 *
 * @param bytes - Entropy in bytes (default 18 ≈ 144 bits, matching the
 *   compose credential generator).
 * @returns The encoded secret, safe to embed in env files unquoted.
 */
export function generateSecret(bytes = 18): string {
  return secureRandomBytes(bytes).toString("base64url");
}

/**
 * Generate a hex-encoded random secret.
 *
 * @param bytes - Entropy in bytes (default 32 = 256 bits, the session-secret
 *   recommendation).
 * @returns Lowercase hex encoding of the random bytes.
 */
export function generateHexSecret(bytes = 32): string {
  return secureRandomBytes(bytes).toString("hex");
}

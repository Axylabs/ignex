/**
 * Secret key rotation — one accepted-secrets ring for every HMAC/Ed25519
 * verifier.
 *
 * Rotation contract: `secrets[0]` is the CURRENT key (every sign/token path
 * uses it); any further entries are PREVIOUS keys kept for the grace window —
 * verifiers try them in order, so tokens, cookies, CSRF tokens and session
 * seals signed before the rotation keep working until the operator drops the
 * old entry. This closes the gap where rotating a secret invalidated every
 * live session/token at once (SECURITY.md's deployment checklist named the
 * rotation step; before the keyring it was destructive).
 *
 * Verification tries each entry with the underlying constant-time verifier;
 * an attacker learns at most "matches ring entry i" from timing, which is the
 * standard trade (JWT `kid` arrays behave the same).
 */

/** A secret, or the rotation ring (current first, previous after). */
export type SecretInput = string | Uint8Array | readonly (string | Uint8Array)[];

/**
 * Normalize a {@link SecretInput} into the ring array (current first).
 * Every entry must be non-empty — an empty secret makes signatures trivially
 * forgeable, so it is a programming error, not a degradation.
 *
 * @throws TypeError when the input is empty or any entry is empty.
 */
export const normalizeSecrets = (input: SecretInput): readonly (string | Uint8Array)[] => {
  const ring = Array.isArray(input) ? input : [input];
  if (ring.length === 0) {
    throw new TypeError("secret ring requires at least one secret");
  }
  for (const entry of ring) {
    if (entry.length === 0) {
      throw new TypeError("secret ring requires non-empty secrets");
    }
  }
  return ring.slice();
};

/** The current (signing) secret — always ring entry 0. */
export const signSecret = (input: SecretInput): string | Uint8Array => {
  const current = normalizeSecrets(input)[0];
  if (current === undefined) throw new TypeError("secret ring requires at least one secret");
  return current;
};

/**
 * Try a verification attempt against every ring entry, in order (current
 * first). `attempt` returns the verified payload or `null` — the first
 * non-null result wins; `null` means no ring entry accepted the input.
 */
export const verifyWithRing = <T>(
  input: SecretInput,
  attempt: (secret: string | Uint8Array) => T | null,
): T | null => {
  for (const secret of normalizeSecrets(input)) {
    const result = attempt(secret);
    if (result !== null) return result;
  }
  return null;
};

/**
 * Try a boolean verification attempt against every ring entry, in order.
 * First `true` wins; all-`false` means rejected.
 */
export const verifyBoolWithRing = (
  input: SecretInput,
  attempt: (secret: string | Uint8Array) => boolean,
): boolean => verifyWithRing(input, (secret) => (attempt(secret) ? true : null)) === true;

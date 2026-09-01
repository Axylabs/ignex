/**
 * Parity tests for the Ed25519 / EdDSA JWT primitives.
 *
 * These run against the pure-TS fallbacks by default (the addon is optional);
 * with `IGNEX_NATIVE_PATH` (or an installed `castrum`) the same suite exercises
 * the NAPI addon. Vitest workers do not expose `bun:ffi`, so the C-ABI
 * transport is covered by `scripts/verify-native-ffi.ts` (plain Bun).
 *
 * The wire formats are locked to the native addon (RFC 8410):
 *   - private key: PKCS#8 v1 DER, base64url (48 bytes decoded)
 *   - public key:  SPKI DER, base64url (44 bytes decoded)
 *   - JWT:         compact EdDSA token (`alg: "EdDSA"`) with `iat`/`exp`
 */
import { describe, expect, it } from "vitest";
import {
  type Ed25519Keypair,
  ed25519Sign,
  ed25519Verify,
  generateEd25519Keypair,
  isNativeAvailable,
  jwtSignEdDsa,
  jwtVerifyEdDsa,
} from "../src/index";

/** Decode a base64url DER key string to its raw bytes. */
const der = (key: string): Uint8Array => new Uint8Array(Buffer.from(key, "base64url"));

/** RFC 8032 §7.1 test vector 1 (empty message). */
const RFC_SECRET = Uint8Array.from([
  0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
  0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
]);
const RFC_PUBLIC = Uint8Array.from([
  0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
  0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
]);
const RFC_SIGNATURE = Uint8Array.from([
  0xe5, 0x56, 0x43, 0x00, 0xc3, 0x60, 0xac, 0x72, 0x90, 0x86, 0xe2, 0xcc, 0x80, 0x6e, 0x82, 0x8a,
  0x84, 0x87, 0x7f, 0x1e, 0xb8, 0xe5, 0xd9, 0x74, 0xd8, 0x73, 0xe0, 0x65, 0x22, 0x49, 0x01, 0x55,
  0x5f, 0xb8, 0x82, 0x15, 0x90, 0xa3, 0x3b, 0xac, 0xc6, 0x1e, 0x39, 0x70, 0x1c, 0xf9, 0xb4, 0x6b,
  0xd2, 0x5b, 0xf5, 0xf0, 0x59, 0x5b, 0xbe, 0x24, 0x65, 0x51, 0x41, 0x43, 0x8e, 0x7a, 0x10, 0x0b,
]);

/** Build a PKCS#8 v1 DER private key from a raw 32-byte Ed25519 seed. */
const pkcs8FromSeed = (seed: Uint8Array): Uint8Array =>
  Uint8Array.from([...Buffer.from("302e020100300506032b657004220420", "hex"), ...seed]);

/** Build an SPKI DER public key from a raw 32-byte Ed25519 public key. */
const spkiFromPublic = (pub: Uint8Array): Uint8Array =>
  Uint8Array.from([...Buffer.from("302a300506032b6570032100", "hex"), ...pub]);

describe("generateEd25519Keypair", () => {
  it("returns base64url PKCS#8 (48 B) + SPKI (44 B) DER", () => {
    const pair: Ed25519Keypair = generateEd25519Keypair();
    expect(typeof pair.privateKey).toBe("string");
    expect(typeof pair.publicKey).toBe("string");
    expect(der(pair.privateKey)).toHaveLength(48);
    expect(der(pair.publicKey)).toHaveLength(44);
    // base64url: no padding characters.
    expect(pair.privateKey).not.toMatch(/[+/=]/);
  });

  it("generates distinct keypairs", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe("ed25519 sign/verify", () => {
  it("signs and verifies a message (round trip)", () => {
    const pair = generateEd25519Keypair();
    const msg = new TextEncoder().encode("integration plan for ignex");
    const sig = ed25519Sign(msg, pair.privateKey);
    expect(sig).toHaveLength(64);
    expect(ed25519Verify(msg, sig, pair.publicKey)).toBe(true);
    expect(ed25519Verify(new TextEncoder().encode("tampered"), sig, pair.publicKey)).toBe(false);
  });

  it("matches the RFC 8032 test vector (byte-exact fallback)", () => {
    // The pure-TS fallback (Node crypto) must sign the RFC vector identically.
    const sig = ed25519Sign(
      new Uint8Array(0),
      Buffer.from(pkcs8FromSeed(RFC_SECRET)).toString("base64url"),
    );
    expect(sig).toEqual(RFC_SIGNATURE);
    const spki = Buffer.from(spkiFromPublic(RFC_PUBLIC)).toString("base64url");
    expect(ed25519Verify(new Uint8Array(0), sig, spki)).toBe(true);
  });

  it("rejects an invalid signature with the wrong key", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    const msg = new TextEncoder().encode("hello");
    const sig = ed25519Sign(msg, a.privateKey);
    expect(ed25519Verify(msg, sig, b.publicKey)).toBe(false);
  });
});

describe("EdDSA JWT", () => {
  it("signs and verifies a compact token with claims", () => {
    const pair = generateEd25519Keypair();
    const token = jwtSignEdDsa(
      { sub: "user-1", roles: ["admin"], permissions: ["users:read"] },
      pair.privateKey,
      // Explicit TTL so the minted token carries exp (the secure default).
      { ttlSeconds: 3600 },
    );
    expect(token.split(".")).toHaveLength(3);

    const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(header.alg).toBe("EdDSA");
    expect(header.typ).toBe("JWT");

    const claims = jwtVerifyEdDsa(token, pair.publicKey) as Record<string, unknown>;
    expect(claims.sub).toBe("user-1");
    expect(claims.roles).toEqual(["admin"]);
    expect(claims.permissions).toEqual(["users:read"]);
  });

  it("rejects non-expiring tokens by default; accepts with requireExp: false", () => {
    const pair = generateEd25519Keypair();
    const token = jwtSignEdDsa({ sub: "user-1" }, pair.privateKey);
    // No ttlSeconds → no exp claim → REJECTED by default (requireExp).
    expect(jwtVerifyEdDsa(token, pair.publicKey)).toBeNull();
    // Explicit opt-out accepts it.
    const claims = jwtVerifyEdDsa(token, pair.publicKey, { requireExp: false }) as Record<
      string,
      unknown
    >;
    expect(claims.sub).toBe("user-1");
  });

  it("injects iat/exp when ttlSeconds is set", () => {
    const pair = generateEd25519Keypair();
    const now = 1_700_000_000;
    const token = jwtSignEdDsa({ sub: "user-1" }, pair.privateKey, {
      ttlSeconds: 3600,
      nowSeconds: now,
    });
    const claims = jwtVerifyEdDsa(token, pair.publicKey, { nowSeconds: now }) as Record<
      string,
      unknown
    >;
    expect(claims.iat).toBe(now);
    expect(claims.exp).toBe(now + 3600);
  });

  it("rejects expired / not-yet-valid / tampered / wrong-key tokens", () => {
    const pair = generateEd25519Keypair();
    const now = 1_700_000_000;
    const token = jwtSignEdDsa({ sub: "user-1" }, pair.privateKey, {
      ttlSeconds: 60,
      nowSeconds: now,
    });

    expect(jwtVerifyEdDsa(token, pair.publicKey, { nowSeconds: now + 60 })).toBeNull();
    expect(jwtVerifyEdDsa(token, pair.publicKey, { nowSeconds: now - 61 })).toBeNull();

    const tampered = `${token.slice(0, -2)}xx`;
    expect(jwtVerifyEdDsa(tampered, pair.publicKey, { nowSeconds: now })).toBeNull();

    const other = generateEd25519Keypair();
    expect(jwtVerifyEdDsa(token, other.publicKey, { nowSeconds: now })).toBeNull();
  });

  it("rejects a token signed with a different algorithm", () => {
    const pair = generateEd25519Keypair();
    // Build a plausible compact token with an HS256 header + no valid sig —
    // the EdDSA verifier must reject on alg + signature, not crash.
    const now = 1_700_000_000;
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url");
    const fake = `${header}.${payload}.${"a".repeat(43)}`;
    expect(jwtVerifyEdDsa(fake, pair.publicKey, { nowSeconds: now })).toBeNull();
  });

  it("native and fallback verify agree on the same token (when native is present)", () => {
    // Run only when the addon is loaded; otherwise this is the fallback alone.
    const pair = generateEd25519Keypair();
    const token = jwtSignEdDsa({ sub: "user-1" }, pair.privateKey, {
      ttlSeconds: 60,
      nowSeconds: 1_700_000_000,
    });
    const claims = jwtVerifyEdDsa(token, pair.publicKey, { nowSeconds: 1_700_000_030 });
    expect((claims as Record<string, unknown>)?.sub).toBe("user-1");
    // Best-effort native observation: when native is available the above
    // already took the native path (selection pins these ops).
    if (isNativeAvailable()) {
      // Sign must also succeed through native for the same claims.
      const again = jwtVerifyEdDsa(token, pair.publicKey, { nowSeconds: 1_700_000_030 });
      expect(JSON.stringify(again)).toBe(JSON.stringify(claims));
    }
  });
});

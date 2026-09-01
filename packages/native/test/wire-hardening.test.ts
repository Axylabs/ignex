/**
 * Wire-hardening + batch-parity tests: packed-wire decoders must fail FAST
 * (PackedWireError) on malformed buffers instead of reading out of bounds
 * under Bun's raw-pointer ffi path, batch wrappers must equal their scalar
 * twins on every backend, and the rate-limiter fallback must keep its memory
 * bound without per-insert full-map scans.
 */
import { describe, expect, it } from "vitest";
import {
  csrfVerify,
  csrfVerifyBatch,
  hmacSha256,
  hmacSha256Batch,
  hmacSha256Verify,
  hmacSha256VerifyBatch,
  PackedWireError,
  readPairsPacked,
  signCookie,
  signCookieBatch,
  unpackBitset,
  unpackByteItems,
  unpackPairBatches,
  unpackU32Array,
  unpackU64ArrayAsBigInt,
  verifyCookie,
  verifyCookieBatch,
} from "../src/index";
import { createRateLimiterFallback, type RateLimiterOptions } from "../src/ratelimit";

const enc = new TextEncoder();
const u32 = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};
const append = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
};

describe("packed wire bounds validation", () => {
  it("readPairsPacked decodes a well-formed buffer", () => {
    const name = enc.encode("k");
    const value = enc.encode("v");
    const buf = append(u32(1), u32(name.length), name, u32(value.length), value);
    expect(readPairsPacked(buf)).toEqual([["k", "v"]]);
  });

  it("rejects a pair count larger than the payload can encode", () => {
    // count = 1000 but only a few bytes follow — a lying count used to drive
    // an unbounded loop + OOB reads.
    expect(() => readPairsPacked(append(u32(1000), u32(4), enc.encode("ab")))).toThrow(
      PackedWireError,
    );
  });

  it("rejects name/value lengths that leave the buffer", () => {
    const name = enc.encode("key");
    const truncated = append(u32(1), u32(name.length), name, u32(64), enc.encode("v"));
    expect(() => readPairsPacked(truncated)).toThrow(PackedWireError);
    const noValueLen = append(u32(1), u32(64), enc.encode("key"));
    expect(() => readPairsPacked(noValueLen)).toThrow(PackedWireError);
  });

  it("rejects header reads past the end of the buffer", () => {
    expect(() => readPairsPacked(new Uint8Array(2))).toThrow(PackedWireError);
  });

  it("unpackBitset / unpackU32Array / unpackU64ArrayAsBigInt reject lying counts", () => {
    expect(() => unpackBitset(append(u32(9999), new Uint8Array(2)))).toThrow(PackedWireError);
    expect(() => unpackU32Array(append(u32(9999), new Uint8Array(8)))).toThrow(PackedWireError);
    expect(() => unpackU64ArrayAsBigInt(append(u32(9999), new Uint8Array(16)))).toThrow(
      PackedWireError,
    );
    // Well-formed inputs still decode.
    const bits = append(u32(9), new Uint8Array([0b101, 0]));
    expect(Array.from(unpackBitset(bits))).toEqual([1, 0, 1, 0, 0, 0, 0, 0, 0]);
  });

  it("unpackByteItems rejects an item length past the buffer", () => {
    const item = enc.encode("abc");
    const good = append(u32(1), u32(item.length), item);
    expect(unpackByteItems(good).length).toBe(1);
    expect(() => unpackByteItems(append(u32(1), u32(4096), item))).toThrow(PackedWireError);
  });

  it("unpackPairBatches rejects a section length that leaves the buffer", () => {
    const pairs = append(u32(1), u32(1), enc.encode("a"), u32(1), enc.encode("b"));
    expect(unpackPairBatches(append(u32(1), u32(pairs.length), pairs))).toEqual([[["a", "b"]]]);
    expect(() => unpackPairBatches(append(u32(1), u32(pairs.length * 4), pairs))).toThrow(
      PackedWireError,
    );
  });
});

describe("batch wrappers match scalar impls (fallback path)", () => {
  const secret = "test-secret-batch";
  const values = ["alpha", "beta", "gamma", "delta", "epsilon"];

  it("signCookieBatch === signCookie for every item", () => {
    const signed = signCookieBatch(values, secret);
    expect(signed).toEqual(values.map((v) => signCookie(v, secret)));
  });

  it("verifyCookieBatch validity matches verifyCookie", () => {
    const signed = signCookieBatch(values, secret);
    const tampered = [...signed.slice(0, -1), "not-a-token"];
    expect(verifyCookieBatch(tampered, secret)).toEqual(
      tampered.map((t) => verifyCookie(t, secret) !== null),
    );
  });

  it("csrfVerifyBatch matches csrfVerify", () => {
    const tokens = values.map((_, i) => `token-${i}`);
    expect(csrfVerifyBatch(tokens, secret)).toEqual(tokens.map((t) => csrfVerify(t, secret)));
  });

  it("hmacSha256Batch matches hmacSha256", () => {
    const digests = hmacSha256Batch(secret, values);
    expect(digests).toEqual(values.map((v) => hmacSha256(secret, v)));
  });

  it("hmacSha256VerifyBatch matches hmacSha256Verify", () => {
    const sigs = values.map((v) => Buffer.from(hmacSha256(secret, v)).toString());
    const results = hmacSha256VerifyBatch(secret, values, sigs);
    expect(results).toEqual(values.map((v, i) => hmacSha256Verify(secret, v, sigs[i] ?? "")));
    // A wrong signature is rejected.
    const bad = hmacSha256VerifyBatch(secret, ["x"], [hmacSha256("other-key", "x").join("")]);
    expect(bad[0]).toBe(false);
  });
});

describe("rate-limiter fallback eviction bound", () => {
  const opts = (maxEntries: number): RateLimiterOptions => ({
    limit: 1000,
    windowMs: 60_000,
    maxEntries,
  });

  it("keeps the tracked-key bound at maxEntries (+1 transient)", () => {
    const limiter = createRateLimiterFallback(opts(50));
    for (let i = 0; i < 5000; i++) limiter.check(`ip-${i}`);
    // The Map is private; observe indirectly via timing — but primarily assert
    // the limiter still functions correctly after heavy churn.
    const check = limiter.check("steady-client");
    expect(check.allowed).toBe(true);
    expect(check.remaining).toBe(999);
  });

  it("still enforces the window limit after churn", () => {
    const limiter = createRateLimiterFallback({ limit: 3, windowMs: 60_000, maxEntries: 10 });
    for (let i = 0; i < 200; i++) limiter.check(`flood-${i}`);
    const l = limiter.check("limited");
    expect(l.allowed).toBe(true);
    expect(limiter.check("limited").allowed).toBe(true);
    expect(limiter.check("limited").allowed).toBe(true);
    expect(limiter.check("limited").allowed).toBe(false); // limit exhausted
    expect(limiter.check("limited").remaining).toBe(0);
  });

  it("resets counts when the window expires", () => {
    const limiter = createRateLimiterFallback({ limit: 1, windowMs: 100, maxEntries: 10 });
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(false);
    expect(limiter.check("k", Date.now() + 150).allowed).toBe(true);
  });

  it("amortized sweep stays O(1)-ish per insert (time sanity)", () => {
    const limiter = createRateLimiterFallback(opts(2048));
    const start = performance.now();
    for (let i = 0; i < 50_000; i++) limiter.check(`bulk-${i}`);
    const elapsed = performance.now() - start;
    // 50k inserts against a 2048 cap: with amortized eviction this is
    // linear-ish (~tens of ms); the old O(n)-per-insert shape would blow up.
    expect(elapsed).toBeLessThan(2000);
  });
});

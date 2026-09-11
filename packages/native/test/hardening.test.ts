/**
 * Native-layer hardening tests: decompression-bomb caps on the JS fallbacks,
 * password-backend diagnostics, and the telemetry sink contract.
 */
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  brotliDecompress,
  canVerifyPasswordHash,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  gzipDecompress,
  PayloadTooLargeError,
  passwordHashAlgorithm,
  passwordHashFallback,
  passwordVerify,
  reportDegradation,
  resetTelemetryRateLimit,
  setNativeTelemetrySink,
  validateEmail,
  validateEmailFallback,
  validateIpv4,
  validateIpv6,
  validateUuid,
} from "../src/index";

describe("decompression bomb caps", () => {
  // A tiny gzipped payload that expands far beyond its compressed size.
  const bomb = gzipSync(Buffer.alloc(64 * 1024, 0x41)); // ~64 KiB of "A"

  it("gzipDecompress throws PayloadTooLargeError over a small explicit cap", () => {
    // A cap below the default forces the capped zlib path (the native core
    // only honors caps >= its own 64 MiB policy).
    expect(() => gzipDecompress(new Uint8Array(bomb), { maxOutputBytes: 1024 })).toThrow(
      PayloadTooLargeError,
    );
  });

  it("gzipDecompress round-trips within the cap", () => {
    const out = gzipDecompress(new Uint8Array(bomb), {
      maxOutputBytes: DEFAULT_MAX_DECOMPRESSED_BYTES * 4,
    });
    expect(out.length).toBe(64 * 1024);
    expect(out[0]).toBe(0x41);
  });

  it("brotliDecompress enforces the same cap contract", () => {
    const compressed = brotliCompressSync(Buffer.alloc(16 * 1024, 0x42));
    expect(() => brotliDecompress(new Uint8Array(compressed), { maxOutputBytes: 512 })).toThrow(
      PayloadTooLargeError,
    );
    const ok = brotliDecompress(new Uint8Array(compressed), {
      maxOutputBytes: 1024 * 1024,
    });
    expect(ok.length).toBe(16 * 1024);
  });
});

describe("password backend diagnostics", () => {
  it("classifies PHC algorithms", () => {
    expect(passwordHashAlgorithm("$scrypt$N=16384,r=8,p=1$ab$cd")).toBe("scrypt");
    expect(passwordHashAlgorithm("$argon2id$v=19$m=19456,t=2,p=1$abc$def")).toBe("argon2id");
    expect(passwordHashAlgorithm("garbage")).toBe("unknown");
  });

  it("scrypt hashes always verify regardless of backend", () => {
    const hash = passwordHashFallback(
      new TextEncoder().encode("pw"),
      new TextEncoder().encode("salt"),
    );
    expect(hash.startsWith("$scrypt$")).toBe(true);
    expect(canVerifyPasswordHash(hash)).toBe(true);
    expect(passwordVerify("pw", hash)).toBe(true);
  });
});

describe("telemetry sink", () => {
  afterEach(() => {
    setNativeTelemetrySink(null);
    resetTelemetryRateLimit();
  });

  it("custom sinks receive degradation events; broken sinks never throw", () => {
    const events: string[] = [];
    setNativeTelemetrySink((e) => {
      if (e.op === "unit-test") events.push(e.kind);
      throw new Error("sink bug"); // must not propagate
    });
    expect(() => reportDegradation("call-failed", "unit-test", "boom")).not.toThrow();
    expect(events).toEqual(["call-failed"]);
  });

  it("default console sink reports each op once per process", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resetTelemetryRateLimit();
    reportDegradation("surface-missing", "telemetry-once-op", "a");
    reportDegradation("surface-missing", "telemetry-once-op", "b");
    reportDegradation("surface-missing", "other-op", "c");
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("telemetry-once-op"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("other-op"))).toBe(true);
    errSpy.mockRestore();
  });
});

// The byte-input validators used to cross to the Rust core as a `cstring` ARG,
// which is NUL-terminated: an embedded U+0000 truncated the value, so
// `validateEmail("a@b.com\0<script>")` was reported VALID. castrum 0.9.6 moved
// them to a `(ptr,len)` pair; ignex binds that pair. This pins the contract on
// whichever backend the test run resolves (native, or the pure-TS fallback).
describe("validator NUL safety", () => {
  const withNul = (value: string, tail: string): string => `${value}\0${tail}`;

  it("rejects a valid value with a NUL-suffixed payload", () => {
    expect(validateEmail(withNul("a@b.com", "<script>alert(1)</script>"))).toBe(false);
    expect(validateUuid(withNul("123e4567-e89b-42d3-a456-426614174000", "junk"))).toBe(false);
    expect(validateIpv4(withNul("192.168.0.1", "junk"))).toBe(false);
    expect(validateIpv6(withNul("2001:db8::1", "junk"))).toBe(false);
  });

  it("still accepts the NUL-free values", () => {
    expect(validateEmail("ada@example.com")).toBe(true);
    expect(validateUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(validateIpv4("192.168.0.1")).toBe(true);
    expect(validateIpv6("2001:db8::1")).toBe(true);
  });

  it("agrees with the pure-TS fallback on the NUL cases", () => {
    const nulEmail = withNul("a@b.com", "x");
    expect(validateEmail(nulEmail)).toBe(validateEmailFallback(nulEmail));
    expect(validateEmail(nulEmail)).toBe(false);
  });
});

/**
 * Off-thread task runtime bridge (`createTaskRuntime`). The runtime is
 * available on BOTH backends: castrum's Rust pool when the addon ships it
 * (castrum >= 0.9.6), and a synchronous pure-TS fallback otherwise. These tests
 * assert the behavior/parity contract on whichever backend the run resolves —
 * `stats().threads > 0` marks the native pool, `0` the fallback.
 */
import { pbkdf2Sync } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { backend, createTaskRuntime, isNativeTaskRuntime, type TaskRuntime } from "../src/index";

const enc = new TextEncoder();
const dec = new TextDecoder();

const runtimePromise: Promise<TaskRuntime> = createTaskRuntime({ threads: 2 });

afterAll(async () => {
  const runtime = await runtimePromise;
  runtime.shutdown();
});

describe("task runtime bridge", () => {
  it("resolves a runtime with the full op surface", async () => {
    const rt = await runtimePromise;
    for (const method of [
      "gzipCompress",
      "gzipDecompress",
      "brotliDecompress",
      "argon2Verify",
      "pbkdf2Sha256",
      "stats",
      "shutdown",
    ] as const) {
      expect(typeof rt[method]).toBe("function");
    }
    expect(rt.stats().threads).toBeGreaterThanOrEqual(0);
  });

  it("is exposed on the execution backend", () => {
    expect(typeof backend.tasks.createTaskRuntime).toBe("function");
  });

  it("gzip round-trips through the runtime", async () => {
    const rt = await runtimePromise;
    const payload = enc.encode("hello task runtime ".repeat(200));
    const compressed = await rt.gzipCompress(payload);
    expect(compressed.length).toBeLessThan(payload.length);
    const restored = await rt.gzipDecompress(compressed);
    expect(dec.decode(restored)).toBe(dec.decode(payload));
  });

  it("rejects a decompress over the requested cap", async () => {
    const rt = await runtimePromise;
    const compressed = await rt.gzipCompress(enc.encode("A".repeat(64 * 1024)));
    await expect(rt.gzipDecompress(compressed, { maxDecompressed: 1024 })).rejects.toThrow();
  });

  it("PBKDF2-HMAC-SHA256 matches node:crypto byte-for-byte", async () => {
    const rt = await runtimePromise;
    const derived = await rt.pbkdf2Sha256(enc.encode("password"), enc.encode("salt"), {
      rounds: 1000,
      dkLen: 32,
    });
    const expected = pbkdf2Sync("password", "salt", 1000, 32, "sha256");
    expect(Buffer.from(derived).equals(expected)).toBe(true);
  });

  it("argon2Verify never accepts a malformed PHC", async () => {
    const rt = await runtimePromise;
    // The native op may reject or return false for a malformed PHC; either way
    // it must NOT report a successful verification.
    const accepted = await rt
      .argon2Verify(enc.encode("pw"), enc.encode("not-a-phc"))
      .catch(() => false);
    expect(accepted).toBe(false);
  });

  it("reports the backend consistently", async () => {
    const rt = await runtimePromise;
    expect(isNativeTaskRuntime(rt)).toBe(rt.stats().threads > 0);
  });
});

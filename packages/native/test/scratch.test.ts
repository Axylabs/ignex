/**
 * Tests for the reusable scratch-buffer pool (`@ignex/native` scratch module).
 *
 * Contract:
 *  - `acquire(n)` returns a buffer of at least `n` bytes.
 *  - Released buffers are REUSED (same underlying `ArrayBuffer`), so steady
 *    state stops allocating.
 *  - `withScratch` always returns the buffer (even on throw) → no leak.
 *  - Oversized borrows bypass the pool (never retained).
 *  - `copyView` produces an independent copy (escapes safely).
 */
import {
  acquire,
  copyView,
  MAX_SCRATCH_BYTES,
  poolStats,
  release,
  withScratch,
} from "@ignex/native";
import { describe, expect, it, vi } from "vitest";

// Poison mode is env-gated at MODULE LOAD, so these tests load a fresh module
// instance with IGNEX_SCRATCH_POISON=1 set (vi.resetModules + dynamic import).
const loadPoisoned = async (): Promise<typeof import("../src/scratch")> => {
  process.env.IGNEX_SCRATCH_POISON = "1";
  vi.resetModules();
  return await import("../src/scratch");
};

describe("scratch pool poisoning (IGNEX_SCRATCH_POISON debug mode)", () => {
  it("fills released buffers with the poison byte", async () => {
    const { withScratch } = await loadPoisoned();
    let escaped: Uint8Array | null = null;
    withScratch(64, (buf) => {
      escaped = buf;
    });
    // Released → poisoned, so a retained reference now sees 0xaa.
    expect(escaped?.[0]).toBe(0xaa);
  });

  it("throws on reuse when a released buffer was written after release", async () => {
    const { acquire, withScratch } = await loadPoisoned();
    let escaped: Uint8Array | null = null;
    withScratch(64, (buf) => {
      escaped = buf;
    });
    // Use-after-release write — exactly the corruption the guard detects.
    //@ts-expect-error
    escaped[0] = 99;
    expect(() => acquire(64)).toThrow(/escaped/);
  });

  it("allows normal reuse when the released buffer stays untouched", async () => {
    const { acquire, release, withScratch } = await loadPoisoned();
    withScratch(64, () => {});
    const buf = acquire(64);
    expect(buf[0]).toBe(0xaa); // intact poison pattern → handed out cleanly
    release(buf);
  });
});

describe("scratch pool", () => {
  it("acquire returns a buffer of at least the requested size", () => {
    const a = acquire(1);
    expect(a.byteLength).toBeGreaterThanOrEqual(1);
    release(a);
    const b = acquire(1000);
    expect(b.byteLength).toBeGreaterThanOrEqual(1000);
    release(b);
  });

  it("reuses the same underlying buffer for sequential same-size borrows", () => {
    const a = acquire(64);
    const ab = a.buffer;
    a.set([1, 2, 3]);
    release(a);

    const b = acquire(64);
    expect(b.buffer).toBe(ab);
    expect(b[0]).toBe(1); // same memory, previous contents still there
    release(b);
  });

  it("grows on demand and keeps the grown buffer pooled", () => {
    const a = acquire(10);
    const firstLen = a.byteLength; // 16 (next power of two)
    release(a);

    const b = acquire(200);
    expect(b.byteLength).toBeGreaterThanOrEqual(200);
    expect(b.byteLength).toBeGreaterThan(firstLen);
    release(b);

    // The grown buffer is reused for the larger request.
    const c = acquire(200);
    expect(c.byteLength).toBeGreaterThanOrEqual(200);
    expect(c.buffer).toBe(b.buffer);
    release(c);
  });

  it("withScratch runs the closure and returns its value", () => {
    const v = withScratch(32, (buf) => {
      buf.set([7, 8, 9]);
      return buf.length;
    });
    expect(v).toBeGreaterThanOrEqual(32);
  });

  it("withScratch returns the buffer to the pool even on throw", () => {
    const before = poolStats().count;
    expect(() =>
      withScratch(32, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(poolStats().count).toBe(before);
  });

  it("nested withScratch calls borrow separate buffers and both return", () => {
    const before = poolStats().count;
    const both = withScratch(16, (outer) =>
      withScratch(16, (inner) => outer.buffer !== inner.buffer),
    );
    expect(both).toBe(true);
    expect(poolStats().count).toBe(before);
  });

  it("oversized borrows bypass the pool and are dropped on release", () => {
    const before = poolStats().count;
    const big = acquire(MAX_SCRATCH_BYTES + 1);
    expect(big.byteLength).toBe(MAX_SCRATCH_BYTES + 1);
    release(big); // byteLength > MAX_POOLED_BYTES → not retained
    expect(poolStats().count).toBe(before);
  });

  it("copyView produces an independent buffer (safe to escape a borrow)", () => {
    const src = new Uint8Array([1, 2, 3]);
    const c = copyView(src);
    c[0] = 99;
    expect(src[0]).toBe(1);
    expect(c[0]).toBe(99);
  });
});

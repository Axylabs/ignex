/**
 * Pooled ByteBuffer decode tests — the shared `flatbuffers.ByteBuffer` used by
 * the generated `decodePayload`. Pins that reusing one buffer across frames is
 * safe: decodes are synchronous and fully materialize the payload, so
 * interleaved frames don't corrupt each other, no lazy reference aliases the
 * shared buffer, frames with a nonzero `byteOffset` decode correctly, and the
 * forced fresh-per-call fallback (flatbuffers internals changed) is identical.
 */
import { describe, expect, test } from "bun:test";
import { decodeFrame } from "../src/generated/registry";
import type { Events } from "../src/schema";
import { __forceFreshPoolForTest, pooledByteBuffer } from "../src/transport/byte-buffer-pool";
import { encodeEvent } from "../src/transport/transport";

const quote = (symbol: string, bid = 180.25): Events["quote"] => ({
  symbol,
  bid,
  ask: 180.3,
  bidSize: 100,
  askSize: 200,
  ts: 1720000000000,
});

const portfolio = (n: number): Events["portfolio"] => ({
  accountId: "acc",
  positions: Array.from({ length: n }, (_, i) => ({
    symbol: `SYM${i}`,
    quantity: i + 1,
    avgPrice: 100 + i * 0.5,
    pnl: (i % 100) - 50,
  })),
  totalValue: 18000,
  cash: 2500,
  ts: 1720000000000,
  updatedBy: "pool-test",
});

describe("pooled ByteBuffer decode", () => {
  test("pooled decode matches the source object", () => {
    const decoded = decodeFrame(encodeEvent("quote", quote("POOL")));
    expect(decoded?.name).toBe("quote");
    expect(Bun.deepEquals(decoded?.payload, quote("POOL"))).toBe(true);
  });

  test("interleaved decodes of different frames don't corrupt each other", () => {
    const frames = [
      encodeEvent("quote", quote("A")),
      encodeEvent("portfolio", portfolio(3)),
      encodeEvent("quote", quote("B")),
      encodeEvent("portfolio", portfolio(1)),
      encodeEvent("quote", quote("C")),
    ];
    const expected = [quote("A"), portfolio(3), quote("B"), portfolio(1), quote("C")];
    // decode each in order through the SAME shared pool
    for (let i = 0; i < frames.length; i++) {
      const decoded = decodeFrame(frames[i]!);
      expect(Bun.deepEquals(decoded?.payload, expected[i])).toBe(true);
    }
  });

  test("previously decoded payloads stay intact after decoding newer frames (no aliasing)", () => {
    const first = decodeFrame(encodeEvent("quote", quote("FIRST")))!;
    // decode larger, string-heavy frames afterwards through the shared pool
    decodeFrame(encodeEvent("portfolio", portfolio(50)));
    decodeFrame(encodeEvent("quote", quote("LATER")));
    expect(Bun.deepEquals(first.payload, quote("FIRST"))).toBe(true);
  });

  test("decodes frames with a nonzero byteOffset (absolute indexing)", () => {
    const frame = encodeEvent("quote", quote("OFFSET"));
    const padded = new Uint8Array(frame.byteLength + 16);
    padded.set(frame, 8);
    const view = padded.subarray(8, 8 + frame.byteLength); // byteOffset = 8
    const decoded = decodeFrame(view);
    expect(decoded?.payload).toEqual(quote("OFFSET"));
  });

  test("forced fresh-per-call fallback produces identical results", () => {
    __forceFreshPoolForTest(true);
    try {
      const a = decodeFrame(encodeEvent("quote", quote("FALLBACK")));
      const b = decodeFrame(encodeEvent("portfolio", portfolio(2)));
      expect(Bun.deepEquals(a?.payload, quote("FALLBACK"))).toBe(true);
      expect(Bun.deepEquals(b?.payload, portfolio(2))).toBe(true);
    } finally {
      __forceFreshPoolForTest(false);
    }
  });

  test("pooledByteBuffer positions at the payload start", () => {
    const frame = encodeEvent("quote", quote("POS"));
    const bb = pooledByteBuffer(frame, 5);
    expect(bb.position()).toBe(5);
  });
});

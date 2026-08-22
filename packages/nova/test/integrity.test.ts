/**
 * Data-integrity + complex-object tests.
 *
 * Verifies round-trips preserve EXACT values — unicode strings, IEEE double
 * precision, negative / large int64 within the JS safe-integer range, empty and
 * large arrays, and deep nesting — across BOTH transports:
 *   - DIRECT fast path (flat + packed-vector events: quote, trade, complex)
 *   - JSON fallback path (events with nested single-object tables: order)
 *
 * Requires: `bun run generate` + `cargo build --release`.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { decodeFrame, isControlId } from "../src/generated/registry";
import type { Events } from "../src/schema";
import { encodeEvent } from "../src/transport/transport";
import { roundTrip } from "./helpers";

describe("data integrity — direct fast path (quote, flat)", () => {
  test("unicode + special-char strings round-trip exactly", () => {
    const q: Events["quote"] = {
      // multibyte, emoji (4-byte UTF-8), CJK, quotes, backslash, newline, tab
      symbol: 'AÄP☕L 😀 中文 "quoted" \\back\\ \n tab\t Δ',
      bid: 180.25,
      ask: 180.3,
      bidSize: 100,
      askSize: 200,
      ts: 1720000000000,
    };
    expect(Bun.deepEquals(roundTrip("quote", q), q)).toBe(true);
  });

  test("doubles preserve exact fractional / edge values", () => {
    const q: Events["quote"] = {
      symbol: "AAPL",
      bid: 123.456789,
      ask: -9876.54321,
      bidSize: 3,
      askSize: 4,
      ts: 5,
    };
    expect(Bun.deepEquals(roundTrip("quote", q), q)).toBe(true);
  });

  test("int64 round-trips in the safe integer range (negative, zero, >2^32)", () => {
    const q: Events["quote"] = {
      symbol: "AAPL",
      bid: 1,
      ask: 2,
      bidSize: -9007199254740991, // -(2^53 - 1) — max safe magnitude
      askSize: 0,
      ts: 8000000000000000, // 8e15 (> 2^32, < 2^53 ≈ 9.007e15)
    };
    expect(Bun.deepEquals(roundTrip("quote", q), q)).toBe(true);
  });
});

describe("data integrity — direct fast path, packed vectors (complex)", () => {
  const complex: Events["complex"] = {
    id: "c1",
    names: ["alpha", "βета", "中文", "emoji 🚀"],
    prices: [1.5, -2.25, 0, 1e300, 0.000001],
    counts: [1, -2, 0, 1234567890123, -9007199254740991],
    flags: [true, false, true],
    tags: ["hot", "new", "sale", "hot"],
    active: true,
    total: 999.99,
    ts: 123456789,
  };

  test("all packed-vector kinds round-trip exactly", () => {
    expect(Bun.deepEquals(roundTrip("complex", complex), complex)).toBe(true);
  });

  test("empty vectors decode to [] (not null/undefined)", () => {
    const empty: Events["complex"] = {
      ...complex,
      names: [],
      prices: [],
      counts: [],
      flags: [],
      tags: [],
    };
    const out = roundTrip("complex", empty);
    expect(out.names).toEqual([]);
    expect(out.prices).toEqual([]);
    expect(out.counts).toEqual([]);
    expect(out.flags).toEqual([]);
    expect(out.tags).toEqual([]);
    expect(Bun.deepEquals(out, empty)).toBe(true);
  });

  test("large payload integrity (200 elements per vector)", () => {
    const tagCycle = ["hot", "new", "sale"] as const;
    const big: Events["complex"] = {
      id: "big",
      names: Array.from({ length: 200 }, (_, i) => `name-${i}`),
      prices: Array.from({ length: 200 }, (_, i) => i * 0.5 - 50),
      counts: Array.from({ length: 200 }, (_, i) => i - 100),
      flags: Array.from({ length: 200 }, (_, i) => i % 2 === 0),
      tags: Array.from({ length: 200 }, (_, i) => tagCycle[i % 3]!),
      active: true,
      total: 1,
      ts: 1,
    };
    expect(Bun.deepEquals(roundTrip("complex", big), big)).toBe(true);
  });

  test("large portfolio integrity (500 positions of tables)", () => {
    const p: Events["portfolio"] = {
      accountId: "acc-big",
      positions: Array.from({ length: 500 }, (_, i) => ({
        symbol: `SYM-${i}`,
        quantity: i - 250,
        avgPrice: i * 0.125,
        pnl: (i % 7) - 3,
      })),
      totalValue: 123456.789,
      cash: -0.01,
      ts: 1700000000000,
      updatedBy: "integrity",
    };
    expect(Bun.deepEquals(roundTrip("portfolio", p), p)).toBe(true);
  });
});

describe("data integrity — JSON fallback path (order, deep nesting)", () => {
  const order: Events["order"] = {
    orderId: "ord-1",
    customer: { id: "c1", name: "Ada Lovelace", vip: true, loyaltyPoints: 12345, rating: 4.9 },
    lines: [
      { sku: "SKU-A", qty: 2, unitPrice: 19.99, tags: ["hot", "new"] },
      { sku: "SKU-B", qty: -1, unitPrice: -5.5, tags: ["sale"] },
      { sku: "SKU-C", qty: 0, unitPrice: 0, tags: [] },
    ],
    notes: ["first", "中文 🚀", "line\nbreak"],
    discounts: [0.1, -0.05, 0],
    active: false,
    createdAt: 1700000000000,
    billing: { id: "addr-9", name: "Grace Hopper", vip: false, loyaltyPoints: 7, rating: 3.2 },
  };

  test("nested single-object table + table-of-tables + vector-enum round-trip exactly", () => {
    expect(Bun.deepEquals(roundTrip("order", order), order)).toBe(true);
  });

  test("optional nested table absent decodes to undefined", () => {
    const noBilling: Events["order"] = { ...order, billing: undefined };
    const out = roundTrip("order", noBilling);
    expect(out.billing).toBeUndefined();
  });

  test("embedded NUL survives on the JSON path (JSON.stringify escapes \\u0000)", () => {
    const nul: Events["order"] = { ...order, notes: ["a\u0000b", "plain"] };
    const out = roundTrip("order", nul);
    expect(out.notes[0]).toBe("a\u0000b");
  });
});

describe("optional-string edge cases (direct path)", () => {
  test("empty optional string round-trips as '' (distinct from absent)", () => {
    // Verified empirically: Bun's cstring ARG passes "" as a non-NULL pointer to
    // a NUL-terminated empty string, so Rust keeps Some("") — no conflation.
    const p: Events["portfolio"] = {
      accountId: "a",
      positions: [],
      totalValue: 1,
      cash: 2,
      ts: 3,
      updatedBy: "",
    };
    expect(roundTrip("portfolio", p).updatedBy).toBe("");
  });

  test("absent optional string (undefined/null) decodes to undefined", () => {
    const p: Events["portfolio"] = {
      accountId: "a",
      positions: [],
      totalValue: 1,
      cash: 2,
      ts: 3,
      updatedBy: undefined,
    };
    expect(roundTrip("portfolio", p).updatedBy).toBeUndefined();
  });
});

describe("end-to-end complex object over a real WebSocket", () => {
  test("server.publish(order) → client receives the exact nested object", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const order: Events["order"] = {
      orderId: "e2e-1",
      customer: { id: "c1", name: "Ada Lovelace", vip: true, loyaltyPoints: 12345, rating: 4.9 },
      lines: [
        { sku: "SKU-A", qty: 2, unitPrice: 19.99, tags: ["hot", "new"] },
        { sku: "SKU-B", qty: -1, unitPrice: -5.5, tags: ["sale"] },
      ],
      notes: ["n1", "中文 🚀"],
      discounts: [0.1, -0.05, 0],
      active: true,
      createdAt: 1700000000000,
      billing: { id: "addr-9", name: "Grace Hopper", vip: false, loyaltyPoints: 7, rating: 3.2 },
    };

    const received = new Promise<unknown>((resolve) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => server.publish("order", order);
      ws.onmessage = (ev) => {
        const decoded = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
        if (!decoded || isControlId(decoded.id)) return; // ignore the hello frame
        resolve(decoded);
        ws.close();
        server.stop();
      };
    });

    const decoded = await received;
    expect(Bun.deepEquals((decoded as { payload: unknown }).payload, order)).toBe(true);
  });
});

describe("data integrity — IEEE 754 special values (direct path)", () => {
  test("NaN and ±Infinity round-trip exactly in scalars and packed vectors", () => {
    // doubles cross the FFI as f64, so IEEE specials survive untouched
    const p: Events["portfolio"] = {
      accountId: "ieee",
      positions: [{ symbol: "s", quantity: 1, avgPrice: Infinity, pnl: -Infinity }],
      totalValue: -Infinity,
      cash: NaN,
      ts: 1,
      updatedBy: "u",
    };
    const out = roundTrip("portfolio", p) as Events["portfolio"];
    expect(out.totalValue).toBe(-Infinity);
    expect(Number.isNaN(out.cash)).toBe(true);
    expect(out.positions[0]!.avgPrice).toBe(Infinity);
    expect(out.positions[0]!.pnl).toBe(-Infinity);

    const c: Events["complex"] = {
      id: "ieee",
      names: [],
      prices: [NaN, Infinity, -Infinity, -0],
      counts: [],
      flags: [],
      tags: [],
      active: true,
      total: NaN,
      ts: 1,
    };
    const outc = roundTrip("complex", c) as Events["complex"];
    expect(Number.isNaN(outc.prices[0])).toBe(true);
    expect(outc.prices[1]).toBe(Infinity);
    expect(outc.prices[2]).toBe(-Infinity);
    expect(Object.is(outc.prices[3], -0)).toBe(true); // negative zero is distinct
    expect(Number.isNaN(outc.total)).toBe(true);
  });
});

describe("data integrity — shared-scratch isolation", () => {
  test("encodeEvent returns an owned copy — later encodes never mutate it", () => {
    const a = encodeEvent("quote", {
      symbol: "FIRST",
      bid: 1,
      ask: 2,
      bidSize: 3,
      askSize: 4,
      ts: 5,
    });
    const snapshot = a.slice();
    // overwrite the shared outScratch with a much larger frame, then a small one
    encodeEvent("complex", {
      id: "big",
      names: ["x".repeat(100_000)],
      prices: [1],
      counts: [2],
      flags: [true],
      tags: ["hot"],
      active: true,
      total: 1,
      ts: 1,
    });
    encodeEvent("quote", { symbol: "SECOND", bid: 9, ask: 8, bidSize: 7, askSize: 6, ts: 5 });
    expect(a).toEqual(snapshot); // a is a private copy, untouched by the scratch
  });

  test("interleaved mixed-type encoding never cross-contaminates payloads", () => {
    const cases: { name: keyof Events; payload: Events[keyof Events] }[] = [
      {
        name: "quote",
        payload: { symbol: "AAPL", bid: 180.25, ask: 180.3, bidSize: 100, askSize: 200, ts: 1 },
      },
      { name: "trade", payload: { symbol: "MSFT", price: 400.5, volume: 7, side: "sell", ts: 2 } },
      {
        name: "complex",
        payload: {
          id: "c",
          names: ["a", "β"],
          prices: [1.5, -2.25],
          counts: [1, 1234567890123],
          flags: [true, false],
          tags: ["hot", "sale"],
          active: true,
          total: 999.99,
          ts: 3,
        },
      },
      {
        name: "order",
        payload: {
          orderId: "o",
          customer: { id: "c", name: "n", vip: true, loyaltyPoints: 1, rating: 4.9 },
          lines: [{ sku: "s", qty: 2, unitPrice: 19.99, tags: ["hot"] }],
          notes: ["n", "中文 🚀"],
          discounts: [0.1],
          active: true,
          createdAt: 4,
        },
      },
      {
        name: "portfolio",
        payload: { accountId: "a", positions: [], totalValue: 1, cash: 2, ts: 5, updatedBy: "u" },
      },
    ];

    for (let i = 0; i < 50; i++) {
      for (const { name, payload } of cases) {
        const decoded = decodeFrame(encodeEvent(name, payload));
        expect(decoded?.name).toBe(name);
        expect(Bun.deepEquals(decoded?.payload, payload)).toBe(true);
      }
    }
  });
});

describe("data integrity — large payload growth (FFI needed-size retry)", () => {
  test("1MB string round-trips via the direct packed-vector path", () => {
    const big: Events["complex"] = {
      id: "big",
      names: ["x".repeat(1_000_000)],
      prices: [1],
      counts: [2],
      flags: [true],
      tags: ["hot"],
      active: true,
      total: 1,
      ts: 1,
    };
    const out = roundTrip("complex", big) as Events["complex"];
    expect(out.names[0]!.length).toBe(1_000_000);
  });

  test("1MB string round-trips via the JSON fallback path", () => {
    const big: Events["order"] = {
      orderId: "big",
      customer: { id: "c", name: "n", vip: true, loyaltyPoints: 1, rating: 1 },
      lines: [{ sku: "s", qty: 1, unitPrice: 1, tags: ["hot"] }],
      notes: ["y".repeat(1_000_000)],
      discounts: [0.1],
      active: true,
      createdAt: 1,
    };
    const out = roundTrip("order", big) as Events["order"];
    expect(out.notes[0]!.length).toBe(1_000_000);
  });
});

describe("data integrity — envelope-lookalike content", () => {
  test("size-prefix-lookalike + IGNX magic bytes inside strings cannot corrupt the frame", () => {
    // content that resembles flatbuffer metadata: IGNX magic + a size-prefix
    // pattern. Must round-trip as opaque user data on BOTH paths.
    // NOTE: no NUL here — the direct cstring path truncates at \0 (see
    // security.test.ts), so use a NUL-free lookalike on the direct path.
    const q: Events["quote"] = {
      symbol: "IGNX\x0e\x01\x02\x03junk",
      bid: 1,
      ask: 2,
      bidSize: 3,
      askSize: 4,
      ts: 5,
    };
    expect(roundTrip("quote", q).symbol).toBe(q.symbol);

    // JSON path: embedded NUL (0x00) is preserved here (JSON.stringify escapes it)
    const o: Events["order"] = {
      orderId: "o",
      customer: { id: "c", name: "n", vip: true, loyaltyPoints: 1, rating: 1 },
      lines: [{ sku: "s", qty: 1, unitPrice: 1, tags: ["hot"] }],
      notes: ["IGNX\x0e\x00\x00\x00junk"],
      discounts: [0.1],
      active: true,
      createdAt: 1,
    };
    const out = roundTrip("order", o) as Events["order"];
    expect(out.notes[0]).toBe("IGNX\x0e\x00\x00\x00junk");
  });
});

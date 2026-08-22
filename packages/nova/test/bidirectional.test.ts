/**
 * Bidirectional transport tests (Phase 2):
 *   - the PURE-JS encoder (src/generated/ts-ser) produces valid frames in the
 *     BROWSER path — no Rust FFI involved (flatc object API + pooled builder)
 *   - client.send(...) reaches server.on(...) for inbound-allowed events
 *   - the server drops app events that are NOT in the `inbound` allowlist
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import { decodeFrame, WIRE_HEADER_LEN, WIRE_VERSION } from "../src/generated/registry";
import { encodeEventFrame } from "../src/generated/ts-ser";
import type { Events } from "../src/schema";
import { complex, quote, trade, waitFor } from "./helpers";

describe("pure-JS encoder (browser path, no FFI)", () => {
  test("flat events round-trip through encodeEventFrame → decodeFrame", () => {
    const q = quote("AAPL", {
      bid: 180.25,
      ask: 180.3,
      bidSize: 100,
      askSize: 200,
      ts: 1720000000000,
    });
    const frame = encodeEventFrame("quote", q);
    expect(frame[0]).toBe(WIRE_VERSION);
    expect(frame.byteLength).toBeGreaterThan(WIRE_HEADER_LEN);
    const decoded = decodeFrame(frame);
    expect(decoded?.name).toBe("quote");
    expect(Bun.deepEquals(decoded?.payload, q)).toBe(true);
  });

  test("enum + int64 fields survive the JS encoder (BigInt conversion)", () => {
    const t = trade({ symbol: "MSFT", price: 400.5, volume: 7, side: "sell", ts: 1720000000000 });
    const frame = encodeEventFrame("trade", t);
    const decoded = decodeFrame(frame);
    expect(decoded?.name).toBe("trade");
    expect(Bun.deepEquals(decoded?.payload, t)).toBe(true);
  });

  test("deeply nested order (tables + vectors) round-trips — browser can send deep payloads", () => {
    const order: Events["order"] = {
      orderId: "o1",
      customer: { id: "c", name: "n", vip: true, loyaltyPoints: 1, rating: 1.5 },
      lines: [
        { sku: "s1", qty: 2, unitPrice: 3.5, tags: ["hot", "sale"] },
        { sku: "s2", qty: -1, unitPrice: 0.25, tags: ["new"] },
      ],
      notes: ["a", "中文 🚀"],
      discounts: [0.1, 0.2],
      active: true,
      createdAt: 123456,
      billing: { id: "b", name: "bn", vip: false, loyaltyPoints: 0, rating: 2.5 },
    };
    const frame = encodeEventFrame("order", order);
    const decoded = decodeFrame(frame);
    expect(decoded?.name).toBe("order");
    expect(Bun.deepEquals(decoded?.payload, order)).toBe(true);
  });

  test("packed-vector complex round-trips via the JS encoder", () => {
    const c = complex();
    const frame = encodeEventFrame("complex", c);
    expect(Bun.deepEquals(decodeFrame(frame)?.payload, c)).toBe(true);
  });
});

describe("bidirectional (client → server)", () => {
  test("client.send reaches server.on for an allowed inbound event", async () => {
    const server = createServer({ port: 0, inbound: ["trade"] });
    const received = new Promise<Events["trade"]>((resolve) => {
      server.on("trade", (payload) => resolve(payload));
    });
    const client = createClient(`ws://localhost:${server.port}/ws`);
    client.connect();
    await waitFor(() => server.clientCount === 1);
    await Bun.sleep(30); // let the hello handshake settle
    const t = trade();
    client.send("trade", t);
    const payload = await received;
    expect(Bun.deepEquals(payload, t)).toBe(true);
    client.close();
    server.stop();
  });

  test("the server drops app events NOT in the inbound allowlist", async () => {
    const server = createServer({ port: 0, inbound: [] });
    let delivered = false;
    server.on("trade", () => {
      delivered = true;
    });
    const client = createClient(`ws://localhost:${server.port}/ws`);
    client.connect();
    await waitFor(() => server.clientCount === 1);
    await Bun.sleep(30);
    client.send("trade", trade());
    await Bun.sleep(100);
    expect(delivered).toBe(false);
    client.close();
    server.stop();
  });
});

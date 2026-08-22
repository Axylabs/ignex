/**
 * Round-trip tests: plain object → Rust FFI FlatBuffer → socket/decoder →
 * plain object. Requires: `bun run generate` + `cargo build --release`.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { decodeFrame, isControlId } from "../src/generated/registry";
import type { Events } from "../src/schema";
import { encodeEvent } from "../src/transport/transport";
import { portfolio, quote, trade } from "./helpers";

const quotePayload: Events["quote"] = quote("AAPL", {
  bid: 180.25,
  ask: 180.3,
  bidSize: 100,
  askSize: 200,
  ts: 1720000000000,
});

const tradePayload: Events["trade"] = trade({
  symbol: "AAPL",
  price: 180.5,
  volume: 10,
  side: "sell",
  ts: 1720000000000,
});

const portfolioPayload: Events["portfolio"] = portfolio();

describe("encode → decode round-trip", () => {
  test("quote", () => {
    const decoded = decodeFrame(encodeEvent("quote", quotePayload));
    expect(decoded?.name).toBe("quote");
    expect(Bun.deepEquals(decoded?.payload, quotePayload)).toBe(true);
  });

  test("trade (enum side stays a string)", () => {
    const decoded = decodeFrame(encodeEvent("trade", tradePayload));
    expect(decoded?.name).toBe("trade");
    expect(Bun.deepEquals(decoded?.payload, tradePayload)).toBe(true);
  });

  test("portfolio (vector of nested tables + optional string)", () => {
    const decoded = decodeFrame(encodeEvent("portfolio", portfolioPayload));
    expect(decoded?.name).toBe("portfolio");
    expect(Bun.deepEquals(decoded?.payload, portfolioPayload)).toBe(true);
  });

  test("missing optional fields decode to undefined, not garbage", () => {
    const noUpdatedBy: Events["portfolio"] = { ...portfolioPayload, updatedBy: undefined };
    const decoded = decodeFrame(encodeEvent("portfolio", noUpdatedBy));
    expect((decoded!.payload as Events["portfolio"]).updatedBy).toBeUndefined();
  });
});

describe("end-to-end over a real Bun WebSocket", () => {
  test("server.publish → client receives a plain typed object", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;

    const received = new Promise<unknown>((resolve) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => server.publish("quote", quotePayload);
      ws.onmessage = (ev) => {
        const decoded = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
        if (!decoded || isControlId(decoded.id)) return; // ignore the hello frame
        resolve(decoded);
        ws.close();
        server.stop();
      };
    });

    const decoded = await received;
    expect(Bun.deepEquals((decoded as { payload: unknown }).payload, quotePayload)).toBe(true);
  });
});

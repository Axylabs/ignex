/**
 * Direct fast-path tests: flat events (quote, trade) serialize via the
 * generated zero-allocation direct-args FFI encoders (no JSON); portfolio (has
 * a vector of tables) falls back to the JSON path. Requires generate + build:rust.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { directEncoders, directSelfTest, directSymbolNames } from "../src/generated/direct-ser";
import { decodeFrame, isControlId } from "../src/generated/registry";
import { getDirectSymbol } from "../src/native/ffi";
import type { Events } from "../src/schema";
import { encodeEvent } from "../src/transport/transport";
import { decodeWsFrame, quote, trade } from "./helpers";

describe("direct fast path", () => {
  test("quote, trade and portfolio all have direct encoders", () => {
    expect(directEncoders["quote"]).toBeDefined();
    expect(directEncoders["trade"]).toBeDefined();
    expect(directEncoders["portfolio"]).toBeDefined(); // packed vector bridge
    expect(directSymbolNames["quote"]).toBe("fb_quote_serialize");
    expect(directSymbolNames["portfolio"]).toBe("fb_portfolio_serialize");
  });

  test("bind-time self-test detects and disables broken direct symbols", () => {
    // A healthy symbol must pass; `() => 0` (the error sentinel) must fail.
    const good = getDirectSymbol("fb_quote_serialize");
    expect(good).toBeDefined();
    const raw = {
      fb_quote_serialize: good!,
      fb_trade_serialize: () => 0,
      fb_portfolio_serialize: () => 0,
    };
    const disabled = directSelfTest(raw, new Uint8Array(2048));
    expect(disabled).toContain("fb_trade_serialize");
    expect(disabled).toContain("fb_portfolio_serialize");
    expect(disabled).not.toContain("fb_quote_serialize");
  });

  test("direct quote round-trips through the real FFI symbol", () => {
    const q = quote("AAPL", {
      bid: 180.25,
      ask: 180.3,
      bidSize: 100,
      askSize: 200,
      ts: 1720000000000,
    });
    expect(Bun.deepEquals(decodeFrame(encodeEvent("quote", q))?.payload, q)).toBe(true);
  });

  test("direct trade enum round-trips to a string", () => {
    const t = trade({ symbol: "MSFT", price: 400.5, volume: 7, side: "sell", ts: 1720000000000 });
    expect(Bun.deepEquals(decodeFrame(encodeEvent("trade", t))?.payload, t)).toBe(true);
  });

  test("shared output scratch is safe across sends (ws.send copies)", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const N = 5000;
    const seen: number[] = [];
    const done = new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        for (let i = 0; i < N; i++) {
          server.publish("quote", {
            symbol: `S${i % 3}`,
            bid: i,
            ask: i + 0.5,
            bidSize: 1,
            askSize: 2,
            ts: i,
          });
        }
      };
      ws.onmessage = (ev) => {
        const decoded = decodeWsFrame(ev);
        if (!decoded || isControlId(decoded.id)) return; // ignore the hello frame
        const q = decoded?.payload as Events["quote"];
        seen.push(q.bid);
        if (seen.length === N) {
          ws.close();
          server.stop();
          resolve();
        }
      };
    });
    await done;
    expect(seen.length).toBe(N);
    // every frame must carry its own bid (no scratch-reuse corruption)
    for (let i = 0; i < N; i++) expect(seen[i]).toBe(i);
  }, 15000);
});

// oxlint-disable no-loss-of-precision -- deliberate: tests the int64 loss guard
/**
 * Exact int64 (Type.BigInt) + loss-guard tests (Phase 6):
 *   - `bigint` fields round-trip EXACTLY beyond ±2^53-1 (both FFI and JS paths)
 *   - the int64 loss guard catches out-of-safe-range NUMBERS at encode time
 *     (`"throw"` / `"warn"` / `"off"` modes; `"off"` is the default)
 *   - bigint-annotated fields never trip the guard
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { setInt64GuardMode } from "../src/core/int64-guard";
import { decodeFrame } from "../src/generated/registry";
import { encodeEventFrame } from "../src/generated/ts-ser";
import type { Events } from "../src/schema";
import { encodeEvent } from "../src/transport/transport";
import { bigVal, decodeWsFrame, quote } from "./helpers";

describe("exact int64 (Type.BigInt)", () => {
  test("values beyond 2^53 round-trip exactly (FFI path)", () => {
    const v = bigVal({ seq: 9007199254740993n, when: 1720000000000 });
    const out = decodeFrame(encodeEvent("bigVal", v))?.payload as Events["bigVal"];
    expect(out.seq).toBe(9007199254740993n);
    expect(out.when).toBe(1720000000000);
  });

  test("full int64 range (i64::MAX / i64::MIN) round-trips", () => {
    const max = bigVal({ id: "max", seq: 9223372036854775807n, when: 1 });
    const min = bigVal({ id: "min", seq: -9223372036854775808n, when: 2 });
    expect((decodeFrame(encodeEvent("bigVal", max))!.payload as Events["bigVal"]).seq).toBe(
      9223372036854775807n,
    );
    expect((decodeFrame(encodeEvent("bigVal", min))!.payload as Events["bigVal"]).seq).toBe(
      -9223372036854775808n,
    );
  });

  test("the JS encoder (browser path) also preserves bigint", () => {
    const v = bigVal({ seq: -9007199254740993n, when: 2 });
    const out = decodeFrame(encodeEventFrame("bigVal", v))?.payload as Events["bigVal"];
    expect(out.seq).toBe(-9007199254740993n);
  });

  test("server end-to-end: publish bigVal over a real socket", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const got = new Promise<Events["bigVal"]>((resolve) => {
      ws.onmessage = (ev) => {
        const f = decodeWsFrame(ev);
        if (!f || f.name !== "bigVal") return;
        resolve(f.payload as Events["bigVal"]);
      };
    });
    await new Promise<void>((r) => (ws.onopen = () => r()));
    server.publish("bigVal", bigVal({ id: "live", seq: 12345678901234567n, when: 3 }));
    const out = await got;
    expect(out.seq).toBe(12345678901234567n);
    ws.close();
    server.stop();
  });
});

describe("loss guard (plain number int64)", () => {
  // eslint-disable-next-line no-loss-of-precision -- deliberate: the guard exists to catch this
  const bad = (): Events["quote"] =>
    // biome-ignore lint/correctness/noPrecisionLoss: deliberate — the loss guard exists to catch this
    quote("AAPL", { bid: 1, ask: 2, bidSize: 9007199254740993, askSize: 3, ts: 4 });
  const good = (): Events["quote"] =>
    quote("AAPL", { bid: 1, ask: 2, bidSize: 9007199254740991, askSize: 3, ts: 4 });

  test('"off" (default) does not throw', () => {
    setInt64GuardMode("off");
    expect(() => encodeEvent("quote", bad())).not.toThrow();
  });

  test('"throw" rejects out-of-safe-range numbers', () => {
    setInt64GuardMode("throw");
    expect(() => encodeEvent("quote", bad())).toThrow(/safe-integer/);
    expect(decodeFrame(encodeEvent("quote", good()))?.name).toBe("quote"); // in-range fine
  });

  test('"warn" does not throw', () => {
    setInt64GuardMode("warn");
    expect(() => encodeEvent("quote", bad())).not.toThrow();
  });

  test("bigint-annotated fields never trip the guard", () => {
    setInt64GuardMode("throw");
    const v: Events["bigVal"] = { id: "b", seq: 9223372036854775807n, when: 1 };
    expect(() => encodeEvent("bigVal", v)).not.toThrow();
  });

  afterAll(() => setInt64GuardMode("off"));
});

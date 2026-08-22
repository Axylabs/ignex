/**
 * FFI binding tests (requires: `bun run generate` + `cargo build --release`).
 */
import { describe, expect, test } from "bun:test";
import { eventNameToId, WIRE_HEADER_LEN, WIRE_VERSION } from "../src/generated/registry";
import { FB_PROBE_MAGIC, getFfi } from "../src/native/ffi";
import { encodeEvent } from "../src/transport/transport";

describe("bun:ffi binding", () => {
  test("fb_probe self-test magic matches", () => {
    expect(getFfi().fb_probe()).toBe(FB_PROBE_MAGIC);
  });

  test("fb_wire_version matches the generated WIRE_VERSION (stale-cdylib guard)", () => {
    expect(getFfi().fb_wire_version()).toBe(WIRE_VERSION);
  });

  test("encodeEvent produces a [version][event_id:u32][size-prefixed flatbuffer] frame", () => {
    const frame = encodeEvent("quote", {
      symbol: "AAPL",
      bid: 180.25,
      ask: 180.3,
      bidSize: 100,
      askSize: 200,
      ts: 1720000000000,
    });
    expect(frame[0]).toBe(WIRE_VERSION);
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(dv.getUint32(1, true)).toBe(eventNameToId["quote"]);
    // size prefix (LE u32) == flatbuffer length (frame minus header minus prefix)
    const sizePrefix = dv.getUint32(WIRE_HEADER_LEN, true);
    expect(sizePrefix).toBe(frame.byteLength - WIRE_HEADER_LEN - 4);
  });

  test("unknown event id returns 0 (error)", () => {
    // directly exercise the C-ABI error path
    const ffi = getFfi();
    const out = new Uint8Array(1024);
    const w = (ffi.fb_serialize as (id: number, json: string, out: Uint8Array) => number)(
      0xdead_beef,
      "{}",
      out,
    );
    expect(w).toBe(0);
  });
});

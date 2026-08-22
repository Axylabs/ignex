/**
 * Wire-envelope tests for the Phase-1 hardening:
 *   - FNV-1a hash is stable + matches known vectors
 *   - event ids are the hash of the name (NOT insertion order) and are distinct
 *   - decodeFrame enforces the envelope: [WIRE_VERSION][event_id:u32][flatbuffer]
 *   - version-mismatch / unknown-id frames are rejected with null
 *   - the frame layout is exactly [version][id:4][size-prefixed flatbuffer]
 */
import { describe, expect, test } from "bun:test";
import { fnv1a32 } from "../src/codegen/hash";
import {
  decodeFrame,
  eventNameToId,
  idToEventName,
  WIRE_HEADER_LEN,
  WIRE_VERSION,
} from "../src/generated/registry";
import type { EventName } from "../src/schema";
import { encodeEvent } from "../src/transport/transport";
import { quote } from "./helpers";

const NAMES = Object.keys(eventNameToId) as EventName[];

describe("FNV-1a hash helper", () => {
  test("known vectors (standard FNV-1a 32)", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5); // offset basis
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  test("is deterministic and unsigned-32-bit", () => {
    for (const n of NAMES) {
      expect(fnv1a32(n)).toBe(fnv1a32(n));
      expect(fnv1a32(n)).toBeGreaterThanOrEqual(0);
      expect(fnv1a32(n)).toBeLessThanOrEqual(0xffff_ffff);
    }
  });
});

describe("stable event ids", () => {
  test("eventNameToId is fnv1a32 of the name (not insertion order)", () => {
    for (const n of NAMES) expect(eventNameToId[n]).toBe(fnv1a32(n));
  });

  test("all ids are distinct (no collisions)", () => {
    const seen = new Set(NAMES.map((n) => eventNameToId[n]));
    expect(seen.size).toBe(NAMES.length);
  });

  test("id → name mapping is bijective", () => {
    for (const n of NAMES) expect(idToEventName[eventNameToId[n]]).toBe(n);
  });

  test("ids are stable regardless of registry position (reorder-safe)", () => {
    // If a future schema moves "trade" earlier/later, its id must not change.
    expect(eventNameToId.trade).toBe(fnv1a32("trade"));
    expect(eventNameToId.portfolio).toBe(fnv1a32("portfolio"));
  });
});

describe("frame envelope layout", () => {
  test("frame is [version][event_id:u32 LE][size-prefixed flatbuffer]", () => {
    const frame = encodeEvent("quote", quote());
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(frame[0]).toBe(WIRE_VERSION);
    expect(dv.getUint32(1, true)).toBe(eventNameToId.quote);
    const size = dv.getUint32(WIRE_HEADER_LEN, true);
    expect(size).toBe(frame.byteLength - WIRE_HEADER_LEN - 4);
  });

  test("round-trips through the new envelope", () => {
    const decoded = decodeFrame(encodeEvent("quote", quote()));
    expect(decoded?.name).toBe("quote");
    expect(decoded?.payload).toMatchObject(quote());
  });

  test("version-mismatched frames are rejected with null", () => {
    const frame = encodeEvent("quote", quote());
    for (const v of [0, 2, 3, 0xff]) {
      const f = frame.slice();
      f[0] = v;
      expect(decodeFrame(f)).toBeNull();
    }
  });

  test("unknown event ids are rejected with null", () => {
    const frame = encodeEvent("quote", quote());
    for (const id of [0, 1, 0x12345678, 0xffff_ffff]) {
      const f = frame.slice();
      new DataView(f.buffer, f.byteOffset).setUint32(1, id, true);
      expect(decodeFrame(f)).toBeNull();
    }
  });

  test("frames shorter than the header are rejected with null", () => {
    for (let len = 0; len < WIRE_HEADER_LEN; len++) {
      expect(decodeFrame(new Uint8Array(len))).toBeNull();
    }
  });
});

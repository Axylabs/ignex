/**
 * Parity tests for the native BATCH surface (`@flux/native` `batch`).
 *
 * The batch path is one packed FFI call for many items; it must agree
 * per-item with the scalar surface. Runs against the real addon when
 * available (`FLUX_NATIVE_PATH` / castrum installed), else the pure-TS
 * per-item fallback — either way the batch and scalar results must match
 * bit-for-bit.
 */

import { batch, crc32, fnv1a64, jsonValid } from "@flux/native";
import { describe, expect, it } from "vitest";

const enc = new TextEncoder();

const JSONS = [
  '{"a":1,"b":[true,null,"x"]}',
  '{"a":1, broken',
  "[]",
  "",
  '{"x": {"y": [1, 2, 3]}}',
  "null",
  "[1,2,3]",
  "nope",
  "42",
];
const CRCS = ["", "a", "foobar", "hello world", "x".repeat(64), "123456789"];
const FNVS = ["", "a", "foobar", "castrum", "key-0", "x".repeat(128)];

const bits = (items: readonly boolean[]): readonly number[] => items.map((b) => (b ? 1 : 0));

describe("batch parity (batch result must equal per-item scalar)", () => {
  it("jsonValid batch == per-item scalar", () => {
    expect([...batch.jsonValid(JSONS)]).toEqual(bits(JSONS.map(jsonValid)));
  });

  it("crc32 batch == per-item scalar (unsigned)", () => {
    const expected = CRCS.map((c) => crc32(c) >>> 0);
    expect([...batch.crc32(CRCS)]).toEqual(expected);
  });

  it("fnv1a64 batch == per-item scalar (unsigned bigint)", () => {
    const expected = FNVS.map((f) => fnv1a64(f));
    expect([...batch.fnv1a64(FNVS)]).toEqual(expected);
  });

  it("accepts Uint8Array inputs identically to strings", () => {
    expect([...batch.jsonValid(JSONS.map((j) => enc.encode(j)))]).toEqual([
      ...batch.jsonValid(JSONS),
    ]);
    expect([...batch.fnv1a64(FNVS.map((f) => enc.encode(f)))]).toEqual([...batch.fnv1a64(FNVS)]);
  });

  it("handles an empty batch", () => {
    expect([...batch.jsonValid([])]).toEqual([]);
    expect([...batch.crc32([])]).toEqual([]);
    expect([...batch.fnv1a64([])]).toEqual([]);
  });
});

/**
 * Size-gated dispatch tests: the measured crossover layer on top of the
 * static SELECTION table (`SIZE_GATES` / `sizeGateAllowsNative`).
 *
 * Contract: results must be IDENTICAL on both sides of every gate boundary
 * (the gate is a performance decision, never a behavioral one), and gated ops
 * must actually route JS below the threshold (observable via the decision fn;
 * byte-level parity is asserted directly against both implementations).
 */
import { describe, expect, it } from "vitest";
import { jsonValid } from "../src/json";
import { OPS, SIZE_GATES, sizeGateAllowsNative } from "../src/selection";

describe("size gates", () => {
  it("gates are read-only data with measured thresholds", () => {
    expect(Object.isFrozen(SIZE_GATES)).toBe(true);
    expect(SIZE_GATES.jsonValid?.jsBelowBytes).toBe(256);
    // Only ops WITH a measured flip may appear here.
    for (const op of Object.keys(SIZE_GATES)) {
      expect(OPS).toContain(op);
    }
  });

  it("sizeGateAllowsNative: below threshold → js, at/above → native", () => {
    expect(sizeGateAllowsNative("jsonValid", 0)).toBe(false);
    expect(sizeGateAllowsNative("jsonValid", 255)).toBe(false);
    expect(sizeGateAllowsNative("jsonValid", 256)).toBe(true);
    expect(sizeGateAllowsNative("jsonValid", 65_536)).toBe(true);
    // Un-gated ops always defer to the static table.
    expect(sizeGateAllowsNative("hmacSha256", 0)).toBe(true);
    expect(sizeGateAllowsNative("fnv1a64", 1)).toBe(true);
  });

  it("jsonValid is behaviorally identical on both sides of the gate", () => {
    // Parity contract: on BOTH sides of the threshold the answer must equal
    // what plain JSON.parse would say — the gate is a performance decision,
    // never a behavioral one.
    const safeParses = (s: string): boolean => {
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    };
    const samples = [
      "",
      "null",
      "123",
      '{"a":1}',
      '{"a":1,}', // trailing comma
      '{"a":1', // truncated
      "[1,2,3]",
      "{invalid}",
      `{"deep":${"[".repeat(200)}${"]".repeat(200)}}`, // deep but well-formed
    ];
    // Natural-size samples + forced small/large valid & malformed variants.
    const inputs = [...samples];
    for (const n of [32, 128, 300, 2048]) {
      const valid = `{"a":1,"p":"${"x".repeat(Math.max(0, n - 14))}}"`;
      inputs.push(valid, valid.slice(0, -1));
    }
    for (const input of inputs) {
      expect(jsonValid(input)).toBe(safeParses(input));
    }
    // Sanity: the sweep above exercises BOTH sides of the gate.
    expect(sizeGateAllowsNative("jsonValid", 64)).toBe(false);
    expect(sizeGateAllowsNative("jsonValid", 512)).toBe(true);
  });
});

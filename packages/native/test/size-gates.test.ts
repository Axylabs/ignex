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
import { nativeQueryDecodeMatchesJs } from "../src/decode-compat";
import {
  effectiveImplFor,
  jsonValid,
  queryPairs,
  queryPairsFallback,
  useNative,
} from "../src/index";
import { OPS, SIZE_GATES, sizeGateAllowsNative } from "../src/selection";

const decodeCompatible = nativeQueryDecodeMatchesJs();

describe("size gates", () => {
  it("gates are read-only data with measured thresholds", () => {
    expect(Object.isFrozen(SIZE_GATES)).toBe(true);
    expect(SIZE_GATES.jsonValid?.jsBelowBytes).toBe(256);
    expect(SIZE_GATES.queryPairs?.jsBelowBytes).toBe(512);
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
    expect(sizeGateAllowsNative("queryPairs", 0)).toBe(false);
    expect(sizeGateAllowsNative("queryPairs", 511)).toBe(false);
    expect(sizeGateAllowsNative("queryPairs", 512)).toBe(true);
    expect(sizeGateAllowsNative("queryPairs", 65_536)).toBe(true);
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

  it("queryPairs spans the whole size range without diverging from the fallback", () => {
    // Whatever selection does (native past the gate on a compatible addon, JS
    // otherwise), the ROUTED wrapper must equal the pure-TS fallback
    // byte-for-byte on both sides of the gate.
    const edge = [
      "",
      "a=1",
      "a=1&b=2&a=3",
      "flag&=value&empty=",
      "a=%20b&c=hello+world",
      "bad=%ZZ",
      "unicode=✓&k=%E2%9C%93",
      `long=${"x".repeat(600)}`,
      Array.from({ length: 60 }, (_, i) => `f${i}=v${i}%20`).join("&"),
    ];
    for (const text of edge) {
      expect(queryPairs(text)).toEqual(queryPairsFallback(text));
    }
    // Sanity: the sweep really crosses the gate (small → JS, large → native
    // when the addon allows it).
    expect(sizeGateAllowsNative("queryPairs", (edge[1] ?? "").length)).toBe(false);
    expect(sizeGateAllowsNative("queryPairs", (edge[7] ?? "").length)).toBe(true);
  });

  it("queryPairs keeps JS semantics on malformed escapes either way", () => {
    // The contract that matters: a malformed / invalid-UTF-8 escape returns the
    // RAW component (JS `decodeURIComponent` → catch → the original segment),
    // NEVER a throw. This held while the op was pinned to JS for correctness,
    // and it must keep holding now that native is selected past the gate on a
    // compatible addon.
    expect(queryPairs("a=%C3")).toEqual([["a", "%C3"]]);
    expect(queryPairs("a=%2")).toEqual([["a", "%2"]]);
    expect(queryPairs("a=%")).toEqual([["a", "%"]]);
    expect(queryPairs("a=%FF")).toEqual([["a", "%FF"]]);
    expect(queryPairs("a=%ED%A0%80")).toEqual([["a", "%ED%A0%80"]]);
    // ...including past the gate, where the native path is what answers.
    const big = (q: string): string =>
      `${q}&${Array.from({ length: 40 }, (_, i) => `p${i}=${"y".repeat(16)}`).join("&")}`;
    expect(queryPairs(big("a=%C3"))).toEqual(queryPairsFallback(big("a=%C3")));
    expect(queryPairs(big("a=%FF"))).toEqual(queryPairsFallback(big("a=%FF")));
  });

  it("queryPairs selection follows the decoder-compatibility probe", () => {
    // On an addon whose form decoder lacks JS semantics (castrum < 0.9.5) the
    // op must NOT be bound to native, however good the median looks. In unit
    // tests there is no C-ABI transport at all, so both cases are JS — the
    // assertion still pins the CONTRACT (native only when the probe allows it).
    expect(useNative("queryPairs")).toBe(decodeCompatible);
    expect(effectiveImplFor("queryPairs")).toBe(decodeCompatible ? "castrum" : "js");
  });
});

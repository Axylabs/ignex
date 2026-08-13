/**
 * Tests for the bulk native-batch parse helpers on `@ignus/core`:
 * `parseQueries` (data/query.ts) and `parseCookies` (http/cookies.ts).
 *
 * Both must produce output IDENTICAL to their per-item scalar counterparts
 * whether they take the native batch path (>= `BATCH_PARSE_THRESHOLD` inputs
 * with the Rust addon loaded) or the per-item scalar path — the batch is an
 * acceleration layer, never a behavior change.
 */

import { describe, expect, it } from "vitest";
import { parseQueries, parseQuery } from "../src/data/query.js";
import { parseCookieString, parseCookies } from "../src/http/cookies.js";

describe("parseQueries (bulk query parsing)", () => {
  it("matches parseQuery per item below the batch threshold", () => {
    const inputs = ["a=1&b=2", "q=hello+world"];
    expect(parseQueries(inputs)).toEqual(inputs.map((q) => parseQuery(q)));
  });

  it("matches parseQuery per item on the native batch path (>= threshold)", () => {
    const inputs = [
      "a=1&b=2",
      "a=1&a=2&b=x+y",
      "q=hello%20world&n=42&flag",
      "",
      "x=%E2%9C%93&y=%26%3D",
      "key=",
      "a=1&b=2",
    ];
    expect(parseQueries(inputs)).toEqual(inputs.map((q) => parseQuery(q)));
  });

  it("groups duplicate keys into arrays (batch path)", () => {
    const out = parseQueries(["a=1&a=2&b=3"]);
    expect(out).toEqual([{ a: ["1", "2"], b: "3" }]);
  });

  it("handles an empty input list", () => {
    expect(parseQueries([])).toEqual([]);
  });
});

describe("parseCookies (bulk cookie-header parsing)", () => {
  it("matches parseCookieString per item below the batch threshold", () => {
    const inputs = ["a=1; b=2", null];
    expect(parseCookies(inputs)).toEqual(inputs.map((c) => parseCookieString(c)));
  });

  it("matches parseCookieString per item on the native batch path (>= threshold)", () => {
    const inputs = [
      "session=abc123; theme=dark; lang=en-US",
      'a=1; b="quoted value"; c=',
      "",
      "flag",
      "x=1; y=2; y=3",
      "a=1; b=2",
      null,
    ];
    expect(parseCookies(inputs)).toEqual(inputs.map((c) => parseCookieString(c)));
  });

  it("returns {} for null and oversized headers on the batch path", () => {
    const oversized = "a=1".padEnd(9000, "x");
    const inputs = [null, oversized, "b=2"];
    const out = parseCookies(inputs);
    expect(out[0]).toEqual({});
    expect(out[1]).toEqual({});
    expect(out[2]).toEqual({ b: "2" });
  });

  it("handles an empty input list", () => {
    expect(parseCookies([])).toEqual([]);
  });
});

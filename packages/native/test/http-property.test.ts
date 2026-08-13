/**
 * Property-based round-trip tests for the `native/src/http/` modules (query,
 * cookie, form, media-type, ETag, Accept-Encoding). Complements the existing
 * parity suite with generated-input invariants ("variety of data").
 */

import { arbCookiePair, arbQsValue, arbQueryPair } from "@ignus/test-utils";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  cookiePairs,
  etag,
  mediaTypeMatches,
  parseAcceptEncoding,
  parseMediaType,
  parseQuery,
  queryPairs,
} from "../src/http/index.js";

describe("queryPairs / parseQuery (property)", () => {
  it("round-trips generated pairs in order (duplicates preserved)", () => {
    fc.assert(
      fc.property(fc.array(arbQueryPair, { maxLength: 8 }), (pairs) => {
        const qs = pairs
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        expect(queryPairs(qs)).toEqual(pairs);
      }),
      { numRuns: 100 },
    );
  });

  it("parseQuery collapses duplicates to the last value per key", () => {
    fc.assert(
      fc.property(fc.array(arbQueryPair, { maxLength: 8 }), (pairs) => {
        const qs = pairs
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        const expected: Record<string, string> = {};
        for (const [k, v] of pairs) expected[k] = v;
        expect(parseQuery(qs)).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("handles empty and edge inputs deterministically", () => {
    expect(queryPairs("")).toEqual([]);
    expect(queryPairs("a=1&&b=2")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(queryPairs("flag")).toEqual([["flag", ""]]);
    expect(queryPairs("a=%zz")).toEqual([["a", "%zz"]]); // malformed stays raw
  });
});

describe("cookiePairs (property)", () => {
  it("round-trips generated cookie pairs", () => {
    fc.assert(
      fc.property(fc.array(arbCookiePair, { maxLength: 8 }), (pairs) => {
        const header = pairs.map(([k, v]) => `${k}=${v}`).join("; ");
        expect(cookiePairs(header)).toEqual(pairs);
      }),
      { numRuns: 100 },
    );
  });

  it("strips quotes and skips empty names", () => {
    expect(cookiePairs('a="1"; ; b=2')).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(cookiePairs("")).toEqual([]);
  });
});

describe("parseMediaType / mediaTypeMatches", () => {
  it("extracts media type, charset and boundary params", () => {
    expect(parseMediaType("Text/HTML; charset=utf-8")).toMatchObject({
      mediaType: "text/html",
      charset: "utf-8",
    });
    expect(parseMediaType("multipart/form-data; boundary=----x")).toMatchObject({
      mediaType: "multipart/form-data",
      boundary: "----x",
    });
    expect(parseMediaType("application/json")).toEqual({
      mediaType: "application/json",
      params: {},
    });
  });

  it("wildcard matching is consistent", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("text/plain", "text/html", "application/json", "image/png"),
        (t) => {
          const [type] = t.split("/");
          expect(mediaTypeMatches(t, "*/*")).toBe(true);
          expect(mediaTypeMatches(t, `${type}/*`)).toBe(true);
          expect(mediaTypeMatches(t, "application/json")).toBe(t === "application/json");
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("etag", () => {
  it("is deterministic and follows the strong/weak format", () => {
    expect(etag("abc")).toBe(etag("abc"));
    expect(etag("abc")).toMatch(/^"[0-9a-f]{8}"$/); // strong by default
    expect(etag("abc", true)).toMatch(/^W\/"[0-9a-f]{8}"$/); // weak opt-in
    expect(etag("abc")).not.toBe(etag("abd"));
  });
});

describe("parseAcceptEncoding (property)", () => {
  it("parses order, case, and q-values", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ encoding: fc.constantFrom("br", "gzip", "deflate"), q: arbQsValue }), {
          maxLength: 6,
        }),
        (prefs) => {
          const header = prefs
            .map((p, i) => `${i % 2 ? p.encoding.toUpperCase() : p.encoding};q=${p.q}`)
            .join(", ");
          const parsed = parseAcceptEncoding(header);
          expect(parsed).toHaveLength(prefs.length);
          parsed.forEach((entry, i) => {
            expect(entry.encoding).toBe(prefs[i]?.encoding);
            expect(entry.q).toBeCloseTo(prefs[i]?.q, 6);
            expect(entry.order).toBe(i);
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("defaults q to 1 and handles empty input", () => {
    expect(parseAcceptEncoding("")).toEqual([]);
    expect(parseAcceptEncoding("gzip")).toEqual([{ encoding: "gzip", q: 1, order: 0 }]);
  });
});

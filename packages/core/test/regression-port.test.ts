/**
 * @fileoverview Port of Elysia `test/regression/security.test.ts` (ReDoS
 * gate) + `test/regression/query-parsing.test.ts` + `test/regression/
 * custom-methods.test.ts` — robustness regressions on the interpreted path.
 *
 * ReDoS gate: IgnEx's regex-backed validators (email / uuid / ipv4) must stay
 * linear — a 200 KB hostile prefix must reject within 250 ms (Elysia uses the
 * same bound against `t.Numeric`). Also pins validator accept/reject vectors
 * and query-string edge cases (malformed escapes, `+`-as-space, missing `=`).
 */

import { createApp, parseQuery, validateEmail, validateIpv4, validateUuid } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

describe("ReDoS gate — regex validators stay linear", () => {
  const gate = (fn: (input: string) => boolean, attack: string): void => {
    const start = performance.now();
    const result = fn(attack);
    const elapsed = performance.now() - start;
    // Linear scan is sub-millisecond; catastrophic backtracking on 200 KB runs
    // for seconds — anything under 250 ms proves the pattern is still linear.
    expect(elapsed).toBeLessThan(250);
    expect(result).toBe(false);
  };

  it("validateEmail rejects a 200 KB local-part attack within 250 ms", () => {
    // A long all-match local part followed by a dangling '@' forces the regex
    // to walk the whole input and then fail — must stay linear and reject.
    gate(validateEmail, `${"a".repeat(200_000)}@`);
  });

  it("validateIpv4 rejects a 200 KB digit attack within 250 ms", () => {
    gate(validateIpv4, `${"9".repeat(200_000)}.1.1.1`);
  });

  it("validateUuid rejects a 200 KB hex-prefix attack within 250 ms", () => {
    gate(validateUuid, `${"9".repeat(200_000)}-4abc-`);
  });
});

describe("validator correctness vectors", () => {
  it("validateEmail accepts valid addresses and rejects invalid ones", () => {
    for (const ok of [
      "a@b.com",
      "user.name+tag@example.co.uk",
      "x@y.io",
      "first_last@domain.org",
    ]) {
      expect(validateEmail(ok)).toBe(true);
    }
    for (const bad of ["", "plain", "a@", "@b.com", "a b@c.com", "a@b", "a@b..com"]) {
      expect(validateEmail(bad)).toBe(false);
    }
  });

  it("validateUuid accepts v4 UUIDs and rejects others", () => {
    for (const ok of ["f47ac10b-58cc-4372-a567-0e02b2c3d479"]) {
      expect(validateUuid(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "f47ac10b-58cc-1372-a567-0e02b2c3d479", // v1, not v4
      "f47ac10b58cc4372a5670e02b2c3d479", // no dashes
      "not-a-uuid",
    ]) {
      expect(validateUuid(bad)).toBe(false);
    }
  });

  it("validateIpv4 accepts dotted quads and rejects invalid ones", () => {
    for (const ok of ["0.0.0.0", "255.255.255.255", "192.168.1.1", "10.0.0.1"]) {
      expect(validateIpv4(ok)).toBe(true);
    }
    for (const bad of ["", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "a.b.c.d"]) {
      expect(validateIpv4(bad)).toBe(false);
    }
  });
});

describe("query string edge cases", () => {
  it("decodes + as space", () => {
    expect(parseQuery("q=hello+world")).toEqual({ q: "hello world" });
  });

  it("preserves malformed percent-encoding without throwing", () => {
    expect(parseQuery("q=%zz&a=1")).toEqual({ q: "%zz", a: "1" });
  });

  it("treats a bare key without = as an empty value", () => {
    expect(parseQuery("flag&a=1")).toEqual({ flag: "", a: "1" });
  });

  it("skips empty segments and handles a leading =", () => {
    expect(parseQuery("&&a=1&&")).toEqual({ a: "1" });
    expect(parseQuery("=x")).toEqual({ "": "x" });
  });

  it("decodes unicode percent-encoding", () => {
    expect(parseQuery("name=%E4%B8%AD%E6%96%87")).toEqual({ name: "中文" });
  });

  it("groups duplicates into arrays preserving order", () => {
    expect(parseQuery("a=1&a=2&a=3")).toEqual({ a: ["1", "2", "3"] });
  });

  it("handles a large query string quickly (no quadratic blowup)", () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `k${i}=v${i}`).join("&");
    const start = performance.now();
    const parsed = parseQuery(big);
    const elapsed = performance.now() - start;

    expect(Object.keys(parsed).length).toBe(20_000);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("custom HTTP methods reach the handler", () => {
  it.each(["PATCH", "DELETE", "OPTIONS", "PUT", "HEAD"])(
    "passes %s through to the interpreted handler",
    async (method) => {
      const res = await inject(
        app((ctx) => ctx.json({ method: ctx.method })),
        {
          method,
          url: "/x",
        },
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ method });
    },
  );
});

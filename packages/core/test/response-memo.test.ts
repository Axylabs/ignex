/**
 * @fileoverview Memoized static response headers (`withBody` ↔ `__withBody`).
 *
 * When a plugin declares `responseDefaults` (e.g. `security()`) the app has an
 * app-invariant header set. `withBody` (interpreted) and `__withBody`
 * (compiler-emitted) both build a boot-memoized base `Headers` (content-type +
 * defaults), hand it to `Response` — which copies it — and set only the
 * dynamic `content-length` per request, replacing a per-response loop of N
 * `Headers.set` calls with one native copy. These tests pin the observable
 * behavior AND the core ↔ codegen parity for that fast path, plus the safety
 * property that one response can never mutate the shared base.
 */
import { describe, expect, it } from "vitest";
import { HELPER_SOURCES } from "../../compiler/src/phases/codegen/helpers";
import { withBody } from "../src/http/finalize";

const encoder = new TextEncoder();

const DEFAULTS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
});

const PARITY_HELPERS = ["__withBody", "jsonReply", "textReply", "htmlReply", "__finalize"] as const;

interface EvaledHelpers {
  __withBody: (bytes: Uint8Array | null, type: string, init?: ResponseInit) => Response;
}

/**
 * Evaluate the codegen helpers exactly as emitted, with a non-null
 * `__DEFAULT_HEADERS` so the memoized fast path is exercised. `__applyStaticHeaders`
 * and `markDecoratedResponse` are the module-scope deps the emitted helpers
 * reference.
 */
const evaledWithDefaults = (() => {
  const body = ["__applyStaticHeaders", ...PARITY_HELPERS]
    .map((h) => HELPER_SOURCES[h])
    .join("\n\n");
  const prelude = `const __DEFAULT_HEADERS = ${JSON.stringify(DEFAULTS)};
const __encoder = new TextEncoder();
const markDecoratedResponse = () => {};`;
  const factory = new Function(
    `${prelude}\n${body}\nreturn { ${PARITY_HELPERS.join(", ")} };`,
  ) as () => EvaledHelpers;
  return factory();
})();

const snapshot = async (r: Response) => ({
  status: r.status,
  ct: r.headers.get("content-type"),
  cl: r.headers.get("content-length"),
  csp: r.headers.get("content-security-policy"),
  frame: r.headers.get("x-frame-options"),
  nosniff: r.headers.get("x-content-type-options"),
  body: await r.text(),
});

describe("memoized static response headers", () => {
  it("applies content-type, content-length, and every default (core ↔ codegen)", async () => {
    const [core, compiled] = await Promise.all([
      snapshot(
        withBody(encoder.encode("hello"), "application/json; charset=utf-8", undefined, DEFAULTS),
      ),
      snapshot(
        evaledWithDefaults.__withBody(
          encoder.encode("hello"),
          "application/json; charset=utf-8",
          undefined,
        ),
      ),
    ]);
    expect(compiled).toEqual(core);
    expect(compiled.ct).toContain("application/json");
    expect(compiled.cl).toBe("5");
    expect(compiled.csp).toBe("default-src 'self'");
    expect(compiled.frame).toBe("SAMEORIGIN");
    expect(compiled.nosniff).toBe("nosniff");
  });

  it("does not leak mutation between responses sharing the memoized base (codegen)", () => {
    // First call uses explicit init headers (general path); the second uses the
    // shared fast path and must not inherit the first response's header.
    const first = evaledWithDefaults.__withBody("a", "text/plain", {
      status: 201,
      headers: { "x-a": "1" },
    });
    const second = evaledWithDefaults.__withBody("bb", "text/plain", undefined);
    expect(first.headers.get("x-a")).toBe("1");
    expect(second.headers.get("x-a")).toBeNull();
    expect(second.headers.get("content-length")).toBe("2");
    expect(second.headers.get("content-security-policy")).toBe("default-src 'self'");
  });

  it("keeps the shared base immutable across core requests", () => {
    const r1 = withBody("one", "text/plain", undefined, DEFAULTS);
    r1.headers.set("x-mut", "1");
    r1.headers.set("content-length", "999");
    const r2 = withBody("two", "text/plain", undefined, DEFAULTS);
    expect(r2.headers.get("x-mut")).toBeNull();
    expect(r2.headers.get("content-length")).toBe("3");
    expect(r2.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("explicit init headers still override the static defaults (core)", () => {
    const r = withBody("x", "text/plain", { headers: { "x-frame-options": "DENY" } }, DEFAULTS);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

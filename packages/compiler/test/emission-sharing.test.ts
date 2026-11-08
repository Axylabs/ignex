/**
 * Emission-level pins for shared request-independent instances.
 *
 * Everything every request receives identically (route-miss bodies/headers,
 * the 503 timeout response) is built ONCE at module load and shared — cutting
 * per-request work — with a hard boundary: an instance is only shared when it
 * carries NO per-request data and nothing downstream can mutate it (a shared
 * mutable instance would leak one request's state onto another). These tests
 * pin both the sharing and the boundary.
 */
import { describe, expect, it } from "vitest";
import { HELPER_SOURCES } from "../src/phases/codegen/helpers";

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("shared request-independent instances", () => {
  it("hoists the server extraction in the static wrappers (one call per request)", () => {
    // The previous emission called __extractServer twice — once for the
    // handler, once on the error path. Both wrappers now hoist one shared
    // `const server` binding.
    expect(countOccurrences(HELPER_SOURCES.__wrapStatic, "__extractServer(a, b)")).toBe(1);
    expect(countOccurrences(HELPER_SOURCES.__wrapStaticSync, "__extractServer(a, b)")).toBe(1);
    expect(HELPER_SOURCES.__wrapStatic).toContain("const server = __extractServer(a, b);");
    expect(HELPER_SOURCES.__wrapStaticSync).toContain("const server = __extractServer(a, b);");
  });

  it("builds the route-miss bodies and the 404 headers once, frozen", () => {
    const src = HELPER_SOURCES.__fallback;
    expect(src).toContain("const __MISS_BODIES = Object.freeze({");
    expect(src).toContain("const __MISS_HEADERS = Object.freeze(");
    // 404 → the shared frozen record (zero allocation); only a 405 spreads it
    // to add the per-path Allow header.
    expect(src).toContain("allow ? { ...__MISS_HEADERS, Allow: allow } : __MISS_HEADERS");
  });

  it("extracts the miss/preflight path with pathnameOf — no per-request URL parse", () => {
    // pathnameOf is core's zero-allocation extractor (the same helper
    // ctx.path uses), so the 405 Allow lookup and ctx.path can never
    // disagree about the request path.
    expect(HELPER_SOURCES.__fallback).toContain("const pathname = pathnameOf(req.url);");
    expect(HELPER_SOURCES.__fallback).toContain("__allowFor(pathname)");
    expect(HELPER_SOURCES.__optionsHandler).toContain("__allowFor(pathnameOf(req.url))");
    expect(HELPER_SOURCES.__fallback).not.toContain("new URL(");
    expect(HELPER_SOURCES.__optionsHandler).not.toContain("new URL(");
  });

  it("keeps the wildcard wrapper's URL parse — a documented correctness boundary", () => {
    // __wrap derives a missing wildcard capture from the URL; URL's
    // normalization must stay consistent with Bun's router matching there, so
    // it deliberately does NOT switch to pathnameOf. If this assertion trips,
    // the change was conscious — re-verify dot-segment behavior against Bun's
    // matcher before keeping it.
    expect(HELPER_SOURCES.__wrap).toContain("new URL(req.url).pathname");
  });
});

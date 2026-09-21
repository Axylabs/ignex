/**
 * @fileoverview Unit tests for the open-redirect guard (`redirect-guard.ts`).
 *
 * `ctx.redirect(url)` historically set the `Location` header verbatim, which
 * let a user-controlled target become an open redirect (`javascript:`,
 * protocol-relative `//evil.com`) or a header-injection vector (CR/LF). These
 * tests pin the guard's SAFE/UNSAFE classification so the later wiring into
 * `ctx.redirect` cannot regress the boundary.
 */

import { describe, expect, it } from "vitest";
import {
  assertSafeRedirectTarget,
  checkRedirectTarget,
  UnsafeRedirectError,
} from "../src/http/redirect-guard";

describe("checkRedirectTarget — accepted targets", () => {
  it.each([
    "/login",
    "/a/b?next=x#frag",
    "./relative",
    "../up",
    "bare-segment",
    "#fragment-only",
    "?query-only",
    "https://example.com/login",
    "http://example.com:8080/path",
    "http://127.0.0.1:3000/ok",
    "https://[::1]/ok",
  ])("accepts %j", (target) => {
    expect(checkRedirectTarget(target)).toMatchObject({ kind: "ok", target });
  });
});

describe("checkRedirectTarget — rejected targets", () => {
  it.each([
    ["javascript:alert(1)", "non-http scheme"],
    ["data:text/html,<script>alert(1)</script>", "non-http scheme"],
    ["vbscript:msgbox(1)", "non-http scheme"],
    ["//evil.com/phish", "protocol-relative"],
    ["///evil.com", "protocol-relative"],
    ["\\\\evil.com\\path", "backslash confusion"],
    ["http:evil.com", "missing authority"],
    ["https:///path", "missing authority"],
    ["", "empty"],
    [" /leading-space", "leading whitespace"],
    ["/path\r\nx-injected: 1", "control chars"],
    ["/path\nset-cookie: x=1", "control chars"],
    ["\u0000null", "control chars"],
  ])("rejects %j (%s)", (target, reasonPart) => {
    const result = checkRedirectTarget(target);
    expect(result.kind).toBe("unsafe");
    if (result.kind === "unsafe") {
      expect(result.reason).toContain(reasonPart);
    }
  });
});

describe("allowExternal escape hatch", () => {
  it("permits protocol-relative targets only when allowExternal is true", () => {
    expect(checkRedirectTarget("//cdn.example.com/x", { allowExternal: true })).toMatchObject({
      kind: "ok",
    });
    expect(checkRedirectTarget("//evil.com/x", { allowExternal: false }).kind).toBe("unsafe");
  });

  it("still rejects non-http schemes even with allowExternal", () => {
    expect(checkRedirectTarget("javascript:alert(1)", { allowExternal: true }).kind).toBe("unsafe");
    expect(checkRedirectTarget("data:text/html,x", { allowExternal: true }).kind).toBe("unsafe");
  });

  it("keeps absolute http(s) targets allowed", () => {
    expect(
      checkRedirectTarget("https://elsewhere.example/x", { allowExternal: true }),
    ).toMatchObject({ kind: "ok" });
  });
});

describe("assertSafeRedirectTarget", () => {
  it("returns the target unchanged when safe", () => {
    expect(assertSafeRedirectTarget("/login")).toBe("/login");
    expect(assertSafeRedirectTarget("https://example.com/x")).toBe("https://example.com/x");
  });

  it("throws UnsafeRedirectError (HTTP 400) for unsafe targets", () => {
    expect(() => assertSafeRedirectTarget("javascript:alert(1)")).toThrowError(
      expect.objectContaining({
        name: "UnsafeRedirectError",
        status: 400,
        code: "UNSAFE_REDIRECT",
        reason: expect.any(String),
      }),
    );
  });

  it("surfaces the classification reason on the error", () => {
    try {
      assertSafeRedirectTarget("//evil.com/x");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeRedirectError);
      expect((err as UnsafeRedirectError).reason).toContain("protocol-relative");
    }
  });
});

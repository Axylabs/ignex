/**
 * @fileoverview `createErrorMapper` — the table-driven domain-error adapter.
 *
 * Pins the contract used by application modules: ordered rules, per-code
 * statuses with a fallback, code prefixes/fixed codes, multi-class rules, and
 * normalisation of non-`Error` throws.
 */

import { createErrorMapper, RequestError } from "@ignex/core";
import { describe, expect, it } from "vitest";

class AddonError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}
class OtherError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
class LateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

describe("createErrorMapper", () => {
  it("maps known codes, falls back for unknown codes, and prefixes the client code", () => {
    const map = createErrorMapper([
      {
        errorClass: AddonError,
        statuses: { NOT_FOUND: 404, FORBIDDEN: 403, INVALID_TRANSITION: 409 },
        fallbackStatus: 422,
        codePrefix: "ADDON",
      },
    ]);

    const notFound = map(new AddonError("NOT_FOUND", "gone"));
    expect(notFound).toBeInstanceOf(RequestError);
    expect(notFound).toMatchObject({ status: 404, message: "gone", code: "ADDON_NOT_FOUND" });

    expect(map(new AddonError("SOMETHING_ELSE"))).toMatchObject({
      status: 422,
      code: "ADDON_SOMETHING_ELSE",
    });
  });

  it("supports a fixed client code (ignoring error.code)", () => {
    const map = createErrorMapper([
      { errorClass: AddonError, statuses: { NOT_FOUND: 404 }, fallbackStatus: 403, code: "DENIED" },
    ]);

    expect(map(new AddonError("NOT_FOUND"))).toMatchObject({ status: 404, code: "DENIED" });
    expect(map(new AddonError("ANY"))).toMatchObject({ status: 403, code: "DENIED" });
  });

  it("matches several error classes in one rule, in rule order", () => {
    const map = createErrorMapper([
      {
        errorClass: [AddonError, OtherError],
        statuses: { NOT_FOUND: 404 },
        fallbackStatus: 400,
        codePrefix: "SHARED",
      },
      {
        errorClass: LateError,
        statuses: { FORBIDDEN: 403 },
        fallbackStatus: 409,
        codePrefix: "LATE",
      },
    ]);

    expect(map(new AddonError("NOT_FOUND"))).toMatchObject({ code: "SHARED_NOT_FOUND" });
    expect(map(new OtherError("NOT_FOUND"))).toMatchObject({ code: "SHARED_NOT_FOUND" });
    expect(map(new LateError("FORBIDDEN"))).toMatchObject({ code: "LATE_FORBIDDEN" });
  });

  it("passes unmatched framework errors through unchanged", () => {
    const map = createErrorMapper([{ errorClass: AddonError, fallbackStatus: 400 }]);
    const original = new RequestError(409, "conflict", "CONFLICT");

    expect(map(original)).toBe(original);
  });

  it("normalises a non-Error throw instead of leaking it", () => {
    const map = createErrorMapper([]);

    const mapped = map("boom");
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped.message).toBe("boom");
  });

  it("supports per-code code/message overrides", () => {
    const map = createErrorMapper([
      {
        errorClass: AddonError,
        statuses: { NOT_FOUND: 404, FORBIDDEN: 403 },
        codes: { NOT_FOUND: "NOT_FOUND", FORBIDDEN: "THING_FORBIDDEN" },
        messages: { NOT_FOUND: "thing not found" },
      },
    ]);

    expect(map(new AddonError("NOT_FOUND", "ignored"))).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "thing not found",
    });
    expect(map(new AddonError("FORBIDDEN", "denied"))).toMatchObject({
      status: 403,
      code: "THING_FORBIDDEN",
      message: "denied",
    });
  });

  it("keeps the domain message verbatim", () => {
    const map = createErrorMapper([
      { errorClass: AddonError, statuses: { NOT_FOUND: 404 }, codePrefix: "X" },
    ]);

    expect(map(new AddonError("NOT_FOUND", "custom detail")).message).toBe("custom detail");
  });
});

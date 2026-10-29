/**
 * `errorMessage` — the single thrown-value normaliser.
 *
 * It is shared by `@ignex/core`, `@ignex/compiler` and `@ignex/cli`; the tests
 * pin the two behaviours callers rely on: an `Error` contributes its message,
 * and a non-`Error` throw still produces a non-empty string (a route that
 * throws a bare string must not answer with an empty error message).
 */

import { describe, expect, it } from "vitest";
import { errorMessage } from "../src";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns the message of a subclass", () => {
    class DomainError extends Error {}
    expect(errorMessage(new DomainError("denied"))).toBe("denied");
  });

  it("stringifies a thrown string", () => {
    expect(errorMessage("plain throw")).toBe("plain throw");
  });

  it("stringifies non-Error throws without producing an empty message", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ code: "X" })).toBe("[object Object]");
  });

  it("uses an empty message when the Error has none", () => {
    expect(errorMessage(new Error(""))).toBe("");
  });
});

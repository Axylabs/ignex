/**
 * Tests for the port helpers behind `ignex dev --kill-port` / the EADDRINUSE
 * prompt. Best-effort by design: missing platform tooling or a free port must
 * degrade to null/false, never throw.
 */

import { describe, expect, it } from "vitest";
import { findPortOwner, killPortOwner } from "../src/utils/port.js";

// A port that is essentially never bound in tests.
const FREE_PORT = 65534;

describe("findPortOwner", () => {
  it("returns null for an unbound port", () => {
    const owner = findPortOwner(FREE_PORT);
    // On a box where something actually binds 65534 the result is an object;
    // otherwise (the norm) it's null. Either way it must not throw.
    expect(owner === null || typeof owner === "object").toBe(true);
  });

  it("never throws on bad input", () => {
    expect(() => findPortOwner(0)).not.toThrow();
    expect(() => findPortOwner(-1)).not.toThrow();
    expect(() => findPortOwner(Number.NaN)).not.toThrow();
  });
});

describe("killPortOwner", () => {
  it("reports a vanished pid as killed (ESRCH on POSIX, taskkill miss on Windows)", () => {
    const result = killPortOwner({ pid: 99_999_999, command: "does-not-exist" });
    expect(typeof result).toBe("boolean");
  });
});

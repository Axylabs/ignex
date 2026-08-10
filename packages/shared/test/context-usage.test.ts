/**
 * ContextUsage tests — the compiler ↔ runtime AOT contract bitmap.
 */

import { type ContextUsage, EMPTY_USAGE, FULL_USAGE } from "@flux/shared";
import { describe, expect, it } from "vitest";

const FLAGS: (keyof ContextUsage)[] = [
  "body",
  "params",
  "query",
  "file",
  "headers",
  "state",
  "json",
  "text",
  "html",
  "redirect",
  "stream",
  "empty",
  "status",
  "req",
  "url",
  "cookie",
  "server",
  "set",
  "sendFile",
  "proxy",
  "forward",
  "cache",
  "loader",
];

describe("ContextUsage", () => {
  it("EMPTY_USAGE has every flag false", () => {
    for (const flag of FLAGS) expect(EMPTY_USAGE[flag]).toBe(false);
  });

  it("FULL_USAGE has every flag true", () => {
    for (const flag of FLAGS) expect(FULL_USAGE[flag]).toBe(true);
  });

  it("both are frozen (immutable contract)", () => {
    expect(Object.isFrozen(EMPTY_USAGE)).toBe(true);
    expect(Object.isFrozen(FULL_USAGE)).toBe(true);
  });

  it("FLAGS list matches the interface exactly (catches contract drift)", () => {
    expect(Object.keys(EMPTY_USAGE).sort()).toEqual(FLAGS.slice().sort());
  });
});

/**
 * `suggest` / `editDistance` — the typo ranking behind
 * "Unknown command 'rout'. Did you mean 'route'?".
 *
 * The ranking is what makes the hint useful: a prefix match must beat a
 * one-edit typo, a typo must beat a two-edit near-miss, and unrelated tokens
 * must produce no hint at all (a wrong guess is worse than silence).
 */

import { describe, expect, it } from "vitest";
import { editDistance, suggest } from "../src/utils/suggest.js";

const COMMANDS = [
  "route",
  "route:list",
  "build",
  "dev",
  "sdk",
  "sdk:push",
  "mcp",
  "jobs",
  "db:migrate",
] as const;

describe("editDistance", () => {
  it("is zero for identical strings", () => {
    expect(editDistance("route", "route")).toBe(0);
  });

  it("counts a single insertion, deletion and substitution", () => {
    expect(editDistance("rout", "route")).toBe(1);
    expect(editDistance("routee", "route")).toBe(1);
    expect(editDistance("routi", "route")).toBe(1);
  });

  it("counts a transposition as one edit (Damerau)", () => {
    expect(editDistance("ruote", "route")).toBe(1);
  });

  it("bails out early once the length gap exceeds the bound", () => {
    expect(editDistance("a", "abcdef", 3)).toBe(4);
    expect(editDistance("route", "route", 0)).toBe(0);
  });

  it("returns a value above max when the strings are far apart", () => {
    expect(editDistance("xyzzy", "route", 3)).toBeGreaterThan(3);
  });
});

describe("suggest", () => {
  it("suggests every prefix match, best-first", () => {
    // Both `route` and `route:list` start with the token, so both are offered.
    expect(suggest("rout", COMMANDS)).toEqual(["route", "route:list"]);
  });

  it("offers a two-edit match (the documented `routlist` case)", () => {
    // Two insertions (`e`, `:`) — only reachable because the bound is two edits.
    expect(suggest("routlist", COMMANDS)).toEqual(["route:list"]);
  });

  it("recovers a dropped separator", () => {
    expect(suggest("queuwork", ["queue:work"])).toEqual(["queue:work"]);
    expect(suggest("dbmigrate", COMMANDS)[0]).toBe("db:migrate");
  });

  it("ranks a prefix match above an edit-distance match", () => {
    const out = suggest("routi", [...COMMANDS]);
    expect(out[0]).toBe("route");
  });

  it("suggests the namespaced command from its prefix", () => {
    expect(suggest("sdk", COMMANDS)).toContain("sdk:push");
    expect(suggest("sdk:pu", COMMANDS)[0]).toBe("sdk:push");
  });

  it("never suggests the token itself", () => {
    expect(suggest("route", COMMANDS)).not.toContain("route");
  });

  it("returns nothing for an unrelated token", () => {
    expect(suggest("kubernetes", COMMANDS)).toEqual([]);
  });

  it("returns nothing for empty input or no candidates", () => {
    expect(suggest("", COMMANDS)).toEqual([]);
    expect(suggest("route", [])).toEqual([]);
  });

  it("honours the limit and stays deterministic", () => {
    expect(suggest("s", COMMANDS, 2)).toHaveLength(2);
    expect(suggest("s", COMMANDS, 2)).toEqual(suggest("s", COMMANDS, 2));
  });

  it("is case-insensitive", () => {
    expect(suggest("ROUT", COMMANDS)).toEqual(["route", "route:list"]);
  });

  it("deduplicates equal candidates that differ only by case", () => {
    const out = suggest("rout", ["route", "route", "Route"]);
    expect(out).toEqual(["route", "Route"]);
  });
});

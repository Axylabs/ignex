/**
 * Tests for the selection table (`src/selection.ts`) — the single source of
 * truth for which implementation each op binds to.
 *
 * These run identically with or without the addon: the table is pure data, so
 * the assertions hold in both CI modes.
 */
import { describe, expect, it } from "vitest";
import { implFor, isNativeAvailable, useNative } from "../src/index";
import { OPS, SELECTION } from "../src/selection";

describe("selection table", () => {
  it("covers every op name and every decision is well-formed", () => {
    expect(OPS.length).toBeGreaterThan(0);
    for (const op of OPS) {
      const d = SELECTION[op];
      expect(d).toBeDefined();
      expect(d.impl === "castrum" || d.impl === "js").toBe(true);
      // Pure-data shape: no functions, optional numeric ratio / string note.
      expect(typeof d).toBe("object");
      expect(d.nativeRatio === undefined || typeof d.nativeRatio === "number").toBe(true);
      expect(d.note === undefined || typeof d.note === "string").toBe(true);
    }
  });

  it("OPS mirrors the SELECTION keys exactly (no drift between the two)", () => {
    expect([...OPS].sort()).toEqual(Object.keys(SELECTION).sort());
  });

  it("implFor agrees with the table for every op", () => {
    for (const op of OPS) {
      expect(implFor(op)).toBe(SELECTION[op].impl);
    }
  });

  it("useNative agrees with the table AND addon availability", () => {
    // In fallback mode useNative is always false; with the addon loaded it
    // follows the table. This holds in both CI modes.
    for (const op of OPS) {
      expect(useNative(op)).toBe(isNativeAvailable() && SELECTION[op].impl === "castrum");
    }
  });

  it("is importable as pure data without the addon (no dlopen side effect)", () => {
    // SELECTION is a plain module-level record; importing it never loads the
    // addon. Assert the object is inert (not a proxy / no getters that could
    // touch native).
    expect(Object.getPrototypeOf(SELECTION)).toBe(Object.prototype);
    expect(() => JSON.parse(JSON.stringify(SELECTION))).not.toThrow();
  });
});

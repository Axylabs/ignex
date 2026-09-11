/**
 * Tests for the selection table (`src/selection.ts`) — the single source of
 * truth for which implementation each op binds to.
 *
 * These run identically with or without the addon: the table is pure data, so
 * the assertions hold in both CI modes.
 */
import { describe, expect, it } from "vitest";
import { nativeQueryDecodeMatchesJs } from "../src/decode-compat";
import { getFfi, implFor, isNativeAvailable, useNative } from "../src/index";
import { OPS, SELECTION } from "../src/selection";

const decodeIsCompatible = nativeQueryDecodeMatchesJs();

/**
 * Ops the live C-ABI transport binds to native even though the static table
 * (castrum's NAPI-era `opImpl`) says `"js"` — i.e. `FFI_WINS` in
 * `src/runtime.ts`. Mirrored here as data so the two can never drift silently:
 * the assertion below is an EQUALITY, so removing an op from `FFI_WINS` (or
 * adding one without updating this list) fails under a live ffi bind.
 */
const FFI_ONLY_OVERRIDES: ReadonlySet<string> = new Set([
  "etag",
  "validateIpv6",
  "hmacSha256",
  "randomToken",
  "jsonValid",
  "queryPairs",
  "aeadEncrypt",
  "crc32",
  "validateUuid",
]);

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

  it("useNative agrees with the table, the FFI overrides AND addon availability", () => {
    // Fallback mode (unit tests alias the addon away): useNative is always
    // false, as before. With the addon loaded (`IGNEX_NATIVE_PATH`) an op is
    // native iff the static table says so OR the live C-ABI transport overrides
    // the NAPI-era decision — `getFfi()` non-null means the ffi bind is up.
    // `queryPairs` additionally needs the decoder-compatibility probe: on an
    // addon whose form decoder lacks JS `decodeURIComponent` semantics
    // (castrum < 0.9.5) the op must stay on JS however good the median looks.
    const ffiLive = getFfi() != null;
    for (const op of OPS) {
      const override = FFI_ONLY_OVERRIDES.has(op) && (op !== "queryPairs" || decodeIsCompatible);
      const expected =
        isNativeAvailable() && (SELECTION[op].impl === "castrum" || (ffiLive && override));
      expect(useNative(op)).toBe(expected);
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

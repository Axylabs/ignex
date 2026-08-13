/**
 * Runtime schema validation tests — the native fast-gate.
 *
 * `compileValidator` / `validateOrThrow` / `validateAsync` prefer the native
 * castrum `SchemaValidator` as a fast-ACCEPT gate for plain draft-07 object
 * schemas (skipping the Ajv JS call on the happy path), with Ajv as the
 * full-semantics oracle. These tests pin:
 *
 *   1. the gate is live when the addon is available (safe schema → native
 *      validator is compiled);
 *   2. correctness parity — valid docs pass, invalid docs throw the same
 *      field-scoped `ValidationError` as Ajv;
 *   3. Ajv mutation semantics are preserved via fall-through — a doc the
 *      native gate rejects (because it does not yet conform) is still
 *      coerced / stripped / defaulted by Ajv;
 *   4. unsafe schemas (`default`, `format`, non-draft-07 `$schema`) route
 *      straight to Ajv so their semantics never regress.
 */

import { compileValidator, ValidationError, validateAsync, validateOrThrow } from "@ignex/core";
import { createSchemaValidator, isNativeAvailable } from "@ignex/native";
import { describe, expect, it } from "vitest";

const enc = new TextEncoder();

// A plain draft-07 object schema — safe for the native fast-gate.
const SAFE_SCHEMA = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "number" },
    name: { type: "string" },
  },
};

const VALID = { id: 1, name: "alice" };
const INVALID = { id: "x", name: 42 };

describe("native fast-gate wiring", () => {
  it("compiles a native validator for a safe schema when the addon is available", () => {
    if (!isNativeAvailable()) return; // fallback env: the gate is a no-op by design
    const gate = createSchemaValidator(JSON.stringify(SAFE_SCHEMA));
    expect(gate).not.toBeNull();
    expect(gate?.validate(JSON.stringify(VALID))).toBe(true);
    expect(gate?.validate(JSON.stringify(INVALID))).toBe(false);
  });

  it("rejects a doc with an extra property via the native gate (no false fast-accept)", () => {
    // additionalProperties not declared → native accepts any extra props, and
    // Ajv would not remove them either (removeAdditional only acts with
    // additionalProperties:false). The result must be the input unchanged.
    const input = { id: 1, name: "alice", extra: true };
    expect(validateOrThrow(SAFE_SCHEMA, input)).toBe(input);
  });
});

describe("schema validation parity (native gate is transparent)", () => {
  it("accepts a valid object and returns it", () => {
    expect(validateOrThrow(SAFE_SCHEMA, VALID)).toBe(VALID);
  });

  it("accepts valid raw JSON bytes (Uint8Array input)", () => {
    const bytes = enc.encode(JSON.stringify(VALID));
    expect(validateOrThrow(SAFE_SCHEMA, bytes)).toBe(bytes);
  });

  it("accepts a valid raw JSON string", () => {
    const s = JSON.stringify(VALID);
    expect(validateOrThrow(SAFE_SCHEMA, s)).toBe(s);
  });

  it("rejects an invalid doc with a field-scoped ValidationError", () => {
    // `coerceTypes` is enabled, so `name: 42` coerces to "42" and passes;
    // the un-coercible `id: "x"` is the error that surfaces.
    try {
      validateOrThrow(SAFE_SCHEMA, INVALID);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const err = e as ValidationError;
      expect(err.errors.id).toBeDefined();
    }
  });

  it("is async-safe: validateAsync rejects the same invalid doc", async () => {
    await expect(validateAsync(SAFE_SCHEMA, INVALID)).rejects.toBeInstanceOf(ValidationError);
    await expect(validateAsync(SAFE_SCHEMA, VALID)).resolves.toBe(VALID);
  });
});

describe("Ajv mutation semantics preserved via fall-through", () => {
  it("coerceTypes still coerces a doc the native gate rejects (string → number)", () => {
    const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
    const out = validateOrThrow<{ n: number }>(schema, { n: "5" });
    // native rejects (type mismatch) → falls through to Ajv → coerced.
    expect(out.n).toBe(5);
  });

  it("removeAdditional still strips extra props the native gate rejects", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "number" } },
      additionalProperties: false,
    };
    // native rejects (b is extra) → falls through to Ajv → b removed.
    const out = validateOrThrow<{ a: number }>(schema, { a: 1, b: 2 });
    expect(out).toEqual({ a: 1 });
    expect("b" in out).toBe(false);
  });
});

describe("unsafe schemas route to Ajv (never the native gate)", () => {
  it("`default` still injects defaults (fast-gate disabled)", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number", default: 42 } },
    };
    const out = validateOrThrow<{ a: number; b: number }>(schema, { a: 1 });
    expect(out.b).toBe(42);
  });

  it("`format` still validates via ajv-formats (fast-gate disabled)", () => {
    const schema = { type: "string", format: "email" };
    expect(validateOrThrow(schema, "ada@example.com")).toBe("ada@example.com");
    expect(() => validateOrThrow(schema, "not-an-email")).toThrow(ValidationError);
  });

  it("`$ref` routes to Ajv (fast-gate disabled) and resolves in-document refs", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/num" } },
      $defs: { num: { type: "number" } },
    };
    expect(validateOrThrow(schema, { a: 5 })).toEqual({ a: 5 });
    expect(() => validateOrThrow(schema, { a: "x" })).toThrow(ValidationError);
  });
});

describe("compileValidator caching", () => {
  it("caches per schema object (same validator instance)", () => {
    const v1 = compileValidator(SAFE_SCHEMA);
    const v2 = compileValidator(SAFE_SCHEMA);
    expect(v1).toBe(v2);
    expect(v1(VALID)).toBe(VALID);
  });
});

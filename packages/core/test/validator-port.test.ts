/**
 * @fileoverview Port of Elysia `test/validator/*` — validation robustness on
 * the interpreted runtime path: prototype-pollution resistance, nested
 * field-scoped errors, coercion/defaults semantics and extra-property
 * stripping via `compileValidator` / `validateOrThrow` / `validateAsync`.
 *
 * The native fast-gate / Ajv-parity matrix is covered by `schema.test.ts`;
 * this file adds the data-integrity scenarios (pollution, nesting, mutation).
 */

import { validateAsync, validateOrThrow } from "@ignex/core";
import { describe, expect, it } from "vitest";

const USER_SCHEMA = {
  type: "object",
  required: ["name", "age"],
  properties: {
    name: { type: "string" },
    age: { type: "number" },
    tags: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

describe("prototype-pollution resistance", () => {
  it("JSON.parse of a __proto__ body does not pollute Object.prototype", () => {
    const body = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(body).toHaveProperty("constructor");
  });

  it("validateOrThrow passes a __proto__-keyed doc through without pollution", () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "name": "a", "age": 1}');
    const out = validateOrThrow(USER_SCHEMA, input);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out).toHaveProperty("name");
  });

  it("validation never writes polluted keys onto Object.prototype", () => {
    try {
      validateOrThrow(
        { type: "object", properties: { admin: { type: "boolean" } }, additionalProperties: false },
        JSON.parse('{"__proto__": {"admin": true}, "name": "a"}'),
      );
    } catch {
      /* 422 expected below — the pollution guard is what we assert */
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
});

describe("nested validation errors", () => {
  it("throws a field-scoped ValidationError for a nested bad value", () => {
    try {
      // Values chosen so coercion cannot rescue either field (arrays/objects
      // are not coercible into string/number).
      validateOrThrow(USER_SCHEMA, { name: [1], age: {} });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as { status: number; code?: string; errors?: Record<string, string[]> };
      expect(e.status).toBe(422);
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.errors).toBeDefined();
      expect(JSON.stringify(e.errors)).toContain("name");
      expect(JSON.stringify(e.errors)).toContain("age");
    }
  });

  it("reports errors for deeply nested properties", () => {
    const nested = {
      type: "object",
      required: ["profile"],
      properties: {
        profile: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "number" } },
        },
      },
    };
    try {
      validateOrThrow(nested, { profile: { id: "not-a-number" } });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as { errors?: Record<string, string[]> };
      expect(e.errors).toBeDefined();
      const serialized = JSON.stringify(e.errors ?? {});
      expect(serialized).toContain("profile");
      expect(serialized).toContain("id");
    }
  });
});

describe("coercion / defaults / extra-property semantics", () => {
  it("coerces string numbers to numbers (coerceTypes)", () => {
    const out = validateOrThrow(USER_SCHEMA, { name: "alice", age: "30", tags: ["a", "b"] });
    expect(out.age).toBe(30);
  });

  it("injects defaults for missing optional properties (useDefaults)", () => {
    const out = validateOrThrow(
      {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number", default: 42 } },
        required: ["a"],
      },
      { a: 1 },
    );

    expect(out.b).toBe(42);
  });

  it("strips undeclared properties when additionalProperties is false", () => {
    const out = validateOrThrow(USER_SCHEMA, { name: "alice", age: 1, extra: "nope" });
    expect(out).not.toHaveProperty("extra");
  });

  it("throws on a missing required property", () => {
    try {
      validateOrThrow(USER_SCHEMA, { name: "alice" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { status: number }).status).toBe(422);
    }
  });
});

describe("validateAsync (standard-schema path)", () => {
  it("resolves a valid doc and rejects an invalid one", async () => {
    const valid = await validateAsync(USER_SCHEMA, { name: "a", age: 1 });
    expect(valid).toHaveProperty("name");

    await expect(validateAsync(USER_SCHEMA, { name: 1, age: "x" })).rejects.toMatchObject({
      status: 422,
    });
  });
});

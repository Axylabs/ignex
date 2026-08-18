import { validateOrThrow } from "@ignex/core";
// TypeBox is the one third-party schema lib available in this workspace; a
// TypeBox schema must validate through ignex's runtime schema engine exactly
// as the equivalent plain JSON-Schema document does (schema-library parity).
// Elysia's multi-validator parity (zod/valibot/arktype) maps here.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

describe("TypeBox schema parity", () => {
  const schema = Type.Object(
    {
      id: Type.Number(),
      name: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
  );

  it("accepts a valid TypeBox-shaped doc", () => {
    const out = validateOrThrow(schema, { id: 1, name: "a", tags: ["x"] });
    expect(out).toHaveProperty("name");
  });

  it("rejects an invalid TypeBox-shaped doc with 422", () => {
    try {
      validateOrThrow(schema, { id: "not-a-number", name: "a" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { status: number }).status).toBe(422);
    }
  });

  it("strips undeclared properties (additionalProperties: false)", () => {
    const out = validateOrThrow(schema, { id: 1, name: "a", extra: true });
    expect(out).not.toHaveProperty("extra");
  });
});

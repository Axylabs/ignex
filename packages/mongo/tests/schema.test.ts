import { describe, expect, test } from "bun:test";
import {
  type InferDoc,
  type ObjectField,
  optional,
  s,
  toMongoSchema,
  toMongoValidator,
  withDefault,
} from "../src/schema/index.ts";

/** Loose view of the converted schema for structural assertions. */
const props = (schema: ObjectField): Record<string, any> => toMongoSchema(schema).properties ?? {};
const vprops = (schema: ObjectField): Record<string, any> =>
  toMongoValidator(schema).$jsonSchema.properties ?? {};

describe("schema DSL → Mongo $jsonSchema", () => {
  const userSchema = s.object({
    _id: s.objectId(),
    email: s.string(),
    name: s.string().optional(),
    age: s.integer({ minimum: 0 }),
    balance: s.number({ minimum: 0 }),
    active: s.boolean(),
    createdAt: s.date(),
    tags: s.array(s.string()),
    role: s.enum(["admin", "user"] as const),
    meta: s.object({ lastLogin: s.date().optional(), notes: s.any() }),
  });

  test("maps scalar bsonTypes", () => {
    const p = vprops(userSchema);
    expect(p.email.bsonType).toBe("string");
    expect(p.age.bsonType).toBe("int");
    expect(p.balance.bsonType).toBe("number");
    expect(p.active.bsonType).toBe("bool");
    expect(p.createdAt.bsonType).toBe("date");
    expect(p.tags.bsonType).toBe("array");
    expect(p.tags.items.bsonType).toBe("string");
    expect(p.role.bsonType).toBe("string");
    expect(p.role.enum).toEqual(["admin", "user"]);
  });

  test("forces _id to objectId", () => {
    expect(props(userSchema)._id.bsonType).toBe("objectId");
  });

  test("respects a declared _id type instead of forcing objectId", () => {
    const v = toMongoSchema(s.object({ _id: s.string(), name: s.string() }));
    expect(v.properties?._id).toEqual({ bsonType: "string" });
  });

  test("injects implicit _id so strict validation never rejects it", () => {
    const v = toMongoSchema(s.object({ name: s.string() }));
    expect(v.properties?._id).toEqual({ bsonType: "objectId" });
    expect(v.additionalProperties).toBe(false);
  });

  test("reserves ORM lifecycle fields (__v, deletedAt) under strict validation", () => {
    const v = toMongoSchema(s.object({ name: s.string() }));
    expect(v.properties?.__v).toEqual({ bsonType: "int" });
    expect(v.properties?.deletedAt).toEqual({ bsonType: ["date", "null"] });
  });

  test("builds required from non-optional fields", () => {
    const v = toMongoSchema(userSchema);
    expect(v.required).toContain("email");
    expect(v.required).toContain("age");
    expect(v.required).not.toContain("name");
    expect(v.required).toContain("meta");
  });

  test("nests object properties and required", () => {
    const p = props(userSchema);
    expect(p.meta.bsonType).toBe("object");
    expect(p.meta.properties.lastLogin.bsonType).toBe("date");
    expect(p.meta.properties.notes.bsonType).toBeUndefined();
  });

  test("carries bounds/constraints", () => {
    const p = props(userSchema);
    expect(p.age.minimum).toBe(0);
    expect(p.balance.minimum).toBe(0);
  });
});

describe("schema DSL type inference", () => {
  const orderSchema = s.object({
    _id: s.objectId(),
    status: s.enum(["pending", "paid"] as const),
    qty: s.integer().optional(),
    total: s.number().default(0),
  });
  type Order = InferDoc<typeof orderSchema>;

  test("infers scalar + literal enum types", () => {
    const doc: Order = {
      _id: null as never, // placeholder; ObjectId not constructible in test
      status: "paid",
      total: 5,
    };
    expect(doc.status).toBe("paid");
  });

  test("optional and default fields are optional at the type level", () => {
    const doc: Order = { _id: null as never, status: "pending", total: 0 };
    expect(doc.qty).toBeUndefined();
  });

  test("optional() standalone modifier works", () => {
    const schema = s.object({ nick: optional(s.string()) });
    type Doc = InferDoc<typeof schema>;
    const doc: Doc = { nick: "n" };
    const doc2: Doc = {};
    expect(doc2.nick).toBeUndefined();
  });
});

describe("schema DSL edge coverage (unit)", () => {
  test("string validators: minLength / maxLength / pattern / bounds", () => {
    const p = vprops(
      s.object({
        code: s.string({ minLength: 3, maxLength: 10 }),
        slug: s.string({ pattern: "^[a-z0-9-]+$" }),
      }),
    );
    expect(p.code.minLength).toBe(3);
    expect(p.code.maxLength).toBe(10);
    expect(p.slug.pattern).toBe("^[a-z0-9-]+$");
  });

  test("`format` is NOT emitted (Mongo rejects the keyword — would break createSchema)", () => {
    const p = vprops(s.object({ email: s.string({ format: "email" }) }));
    expect(p.email.format).toBeUndefined();
    expect(Object.keys(p.email).sort()).toEqual(["bsonType"]);
  });

  test("number: maximum, min+max together, int vs number", () => {
    const p = vprops(
      s.object({
        score: s.number({ minimum: 0, maximum: 100 }),
        temp: s.number({ maximum: 50 }),
        level: s.integer({ minimum: 1, maximum: 5 }),
      }),
    );
    expect(p.score.minimum).toBe(0);
    expect(p.score.maximum).toBe(100);
    expect(p.temp.maximum).toBe(50);
    expect(p.temp.minimum).toBeUndefined();
    expect(p.level.bsonType).toBe("int");
    expect(p.level.maximum).toBe(5);
  });

  test("enums: pure → single bsonType, mixed/null → type-union bsonType", () => {
    const numeric = vprops(s.object({ prio: s.enum([1, 2, 3] as const) }));
    expect(numeric.prio.bsonType).toBe("int");
    expect(numeric.prio.enum).toEqual([1, 2, 3]);

    // Numeric enum with a non-integer member → 'number' matches every numeric BSON type.
    const fractional = vprops(s.object({ score: s.enum([1, 2.5] as const) }));
    expect(fractional.score.bsonType).toBe("number");
    expect(fractional.score.enum).toEqual([1, 2.5]);

    // Mixed string+number enum must accept BOTH members server-side, so the
    // emitted bsonType is the union of every member's type (bsonType∩enum are AND-ed).
    const mixed = vprops(s.object({ flag: s.enum(["a", 1] as const) }));
    expect(mixed.flag.bsonType).toEqual(["string", "int"]);
    expect(mixed.flag.enum).toEqual(["a", 1]);

    const withNull = vprops(
      s.object({ opt: s.enum(["x", null] as unknown as readonly (string | number)[]) }),
    );
    expect(withNull.opt.bsonType).toEqual(["string", "null"]);
    expect(withNull.opt.enum).toEqual(["x", null]);

    const allNull = vprops(
      s.object({ empty: s.enum([null] as unknown as readonly (string | number)[]) }),
    );
    expect(allNull.empty.bsonType).toBe("null");
    expect(allNull.empty.enum).toEqual([null]);
  });

  test("s.null() and s.any() emit their JSON-schema fragments", () => {
    const p = vprops(s.object({ nothing: s.null(), anything: s.any() }));
    expect(p.nothing.bsonType).toBe("null");
    expect(p.anything).toEqual({});
  });

  test("array of objects: items carry required + nested properties", () => {
    const p = vprops(
      s.object({
        items: s.array(s.object({ sku: s.string(), qty: s.integer({ minimum: 1 }) })),
      }),
    );
    expect(p.items.bsonType).toBe("array");
    expect(p.items.items.bsonType).toBe("object");
    expect(p.items.items.required).toEqual(["sku", "qty"]);
    expect(p.items.items.properties.sku.bsonType).toBe("string");
  });

  test("arrays of arrays (2D) and array of enum / objectId items", () => {
    const p = vprops(
      s.object({
        grid: s.array(s.array(s.number())),
        tiers: s.array(s.enum(["a", "b"] as const)),
        refs: s.array(s.objectId()),
      }),
    );
    expect(p.grid.items.bsonType).toBe("array");
    expect(p.grid.items.items.bsonType).toBe("number");
    expect(p.tiers.items.bsonType).toBe("string");
    expect(p.refs.items.bsonType).toBe("objectId");
  });

  test("additionalProperties: strict by default, opt-out with true", () => {
    const strict = vprops(
      s.object({ inner: s.object({ a: s.string() }, { additionalProperties: false }) }),
    );
    const loose = vprops(
      s.object({ inner: s.object({ a: s.string() }, { additionalProperties: true }) }),
    );
    const unset = vprops(s.object({ inner: s.object({ a: s.string() }) }));
    expect(strict.inner.additionalProperties).toBe(false);
    expect(loose.inner.additionalProperties).toBe(true);
    expect(unset.inner.additionalProperties).toBe(false);
  });

  test("deep nesting (object in array in object) with nested required", () => {
    const p = vprops(
      s.object({
        shipment: s.object({
          events: s.array(
            s.object({
              status: s.string(),
              location: s.object({ city: s.string(), country: s.string() }),
            }),
          ),
        }),
      }),
    );
    expect(p.shipment.properties.events.items.bsonType).toBe("object");
    expect(p.shipment.properties.events.items.required).toEqual(["status", "location"]);
    expect(p.shipment.properties.events.items.properties.location.bsonType).toBe("object");
    expect(p.shipment.properties.events.items.properties.location.required).toEqual([
      "city",
      "country",
    ]);
  });

  test("withDefault() standalone modifier + default-on-optional + chain order", () => {
    const p = vprops(
      s.object({
        a: withDefault(s.string(), "x"),
        b: s.boolean().default(true).optional(),
        c: s.string().optional().default("y"),
        d: s.number().default(0).optional(),
      }),
    );
    // defaulted/optional fields are never required
    expect(p.required).toBeUndefined();
    expect(p.a.bsonType).toBe("string");
    expect(p.b.bsonType).toBe("bool");
    expect(p.c.bsonType).toBe("string");
    expect(p.d.bsonType).toBe("number");
  });

  test("description is emitted when provided (hand-built field)", () => {
    const desc = {
      kind: "string",
      flags: { optional: false, hasDefault: false },
      description: "A note",
    } as const;
    const p = vprops(s.object({ note: desc as never }));
    expect(p.note.description).toBe("A note");
  });

  test("strict BSON numeric kinds: double / long / decimal", () => {
    const p = vprops(s.object({ d: s.double({ minimum: 0 }), l: s.long(), dec: s.decimal() }));
    expect(p.d.bsonType).toBe("double");
    expect(p.l.bsonType).toBe("long");
    expect(p.dec.bsonType).toBe("decimal");
    expect(p.d.minimum).toBe(0);
  });

  test("numeric multipleOf + exclusive bounds are emitted", () => {
    const p = vprops(s.object({ step: s.number({ multipleOf: 0.5, exclusiveMinimum: true }) }));
    expect(p.step.multipleOf).toBe(0.5);
    expect(p.step.exclusiveMinimum).toBe(true);
    expect(p.step.exclusiveMaximum).toBeUndefined();
  });

  test("array minItems/maxItems/uniqueItems are emitted", () => {
    const p = vprops(
      s.object({ codes: s.array(s.string(), { minItems: 1, maxItems: 5, uniqueItems: true }) }),
    );
    expect(p.codes.minItems).toBe(1);
    expect(p.codes.maxItems).toBe(5);
    expect(p.codes.uniqueItems).toBe(true);
  });

  test("object minProperties/maxProperties are emitted (root + nested)", () => {
    const v = toMongoSchema(
      s.object({ a: s.string(), b: s.integer() }, { minProperties: 2, maxProperties: 5 }),
    );
    expect(v.minProperties).toBe(2);
    expect(v.maxProperties).toBe(5);
    const nested = vprops(
      s.object({ meta: s.object({ a: s.string() }, { minProperties: 1, maxProperties: 3 }) }),
    );
    expect(nested.meta.minProperties).toBe(1);
    expect(nested.meta.maxProperties).toBe(3);
  });

  test("raw $jsonSchema escape hatch passes the fragment through verbatim", () => {
    const frag = {
      bsonType: "object",
      required: ["a"],
      properties: { a: { bsonType: "string" } },
      patternProperties: { "^x-": { bsonType: "string" } },
    };
    const p = vprops(s.object({ meta: s.jsonSchema(frag) }));
    expect(p.meta).toEqual(frag);
  });
});

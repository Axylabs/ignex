/**
 * Complex schema → real MongoDB round-trip suite.
 *
 * Uses the canonical enterprise model (nested objects, arrays of objects,
 * enums, validators, defaults, `additionalProperties` control, unique indexes)
 * to prove every `$jsonSchema` validator branch is actually enforced
 * server-side, that rejections surface as typed, contextual errors
 * (`DomainError('VALIDATION_FAILED')`), and that the `collMod`/`updateSchema`
 * path works. Uses `wrapMongoErrors: true` so driver errors are mapped.
 *
 * Guarded by a local MongoDB (skipped when unavailable).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Decimal128, Long, ObjectId } from "mongodb";
import { isDomainError } from "../src/errors/index.ts";
import { s, toMongoValidator } from "../src/schema/index.ts";
import { customerSchema } from "./fixtures/enterprise.ts";
import {
  closeService,
  type EnterpriseServiceContext,
  makeEnterpriseService,
  maybeDescribe,
  probe,
} from "./helpers.ts";

const available = await probe();
const maybe = maybeDescribe(available);

const validCustomer = () => ({
  email: `roundtrip@example.com`,
  profile: {
    name: "Round Trip",
    address: {
      street: "1 Test Ave",
      city: "Springfield",
      country: "US",
      geo: { lat: 12.5, lng: -30.1 },
    },
  },
  tier: "gold" as const,
  priority: 2 as const,
  tags: ["vip"],
  prefs: { newsletter: true, locale: "en-US" },
  createdAt: new Date(),
});

const validProduct = () => ({
  sku: "ZZ9999",
  name: "Roundtrip Product",
  category: "books" as const,
  price: 9.99,
  stock: 5,
  tags: ["new"] as ("new" | "sale" | "featured" | "clearance")[],
});

const validOrder = (customerId: ObjectId) => ({
  customerId,
  status: "pending" as const,
  items: [{ sku: "ZZ9999", name: "Item", qty: 2, unitPrice: 9.99 }],
  totals: { subtotal: 19.98, tax: 2.0, shipping: 5, grandTotal: 26.98, currency: "USD" },
  billing: { address: { street: "1 Test Ave", city: "Springfield", country: "US" } },
  placedAt: new Date(),
});

maybe("complex schema → real MongoDB round-trip", () => {
  let ctx: EnterpriseServiceContext;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_orm_schema_complex", {
      wrapMongoErrors: true,
      perf: false,
    });
  });

  afterAll(async () => {
    await closeService(ctx);
  });

  test("valid nested docs insert (validators + indexes installed by seed)", async () => {
    const { db, seed } = ctx;
    expect(seed.customerIds.length).toBeGreaterThan(0);
    const c = await db.getOne("customers", {});
    expect(c?.profile?.address?.geo?.lat).toBeTypeOf("number");
    const o = await db.getOne("orders", {});
    expect(o?.items?.length).toBeGreaterThan(0);
    expect(o?.totals?.grandTotal).toBeGreaterThan(0);
  });

  test("new $jsonSchema keywords enforced server-side (uniqueItems, multipleOf, strict BSON kinds, raw)", async () => {
    const { db } = ctx;
    const schema = s.object({
      code: s.string({ pattern: "^[A-Z]{2}\\d{4}$" }),
      tags: s.array(s.string(), { minItems: 1, maxItems: 3, uniqueItems: true }),
      qty: s.number({ multipleOf: 5 }),
      ratio: s.double({ minimum: 0 }),
      big: s.long(),
      price: s.decimal(),
      meta: s.jsonSchema({ bsonType: "object" }),
    });
    const validator = toMongoValidator(schema);
    const coll = db.client.collection("schema_new_keywords");
    await db.client.dropCollection("schema_new_keywords").catch(() => {});
    await db.client.createCollection("schema_new_keywords", { validator });
    const good = {
      code: "AB1234",
      tags: ["a", "b"],
      qty: 10,
      ratio: 0.5,
      big: Long.fromNumber(1_000_000),
      price: new Decimal128("9.99"),
      meta: { anything: true },
    };
    await coll.insertOne(good); // passes every new keyword
    await expect(coll.insertOne({ ...good, tags: ["a", "a"] })).rejects.toMatchObject({
      code: 121,
    });
    await expect(coll.insertOne({ ...good, tags: ["a", "b", "c", "d"] })).rejects.toMatchObject({
      code: 121,
    });
    await expect(coll.insertOne({ ...good, qty: 7 })).rejects.toMatchObject({ code: 121 });
    await expect(coll.insertOne({ ...good, price: 9.99 })).rejects.toMatchObject({ code: 121 });
    await db.client.dropCollection("schema_new_keywords").catch(() => {});
  });

  test("rejects missing nested required field → VALIDATION_FAILED with context", async () => {
    const { db } = ctx;
    // Intentionally-invalid doc: the type layer is bypassed (cast) so the SERVER
    // validator is what rejects the missing nested `address`.
    const missingAddress = {
      ...validCustomer(),
      profile: { name: "No Address" },
    } as never;
    await expect(db.insertOne("customers", missingAddress)).rejects.toMatchObject({
      name: "DomainError",
      code: "VALIDATION_FAILED",
    });
    try {
      await db.insertOne("customers", missingAddress);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      expect((err as { extra?: Record<string, unknown> }).extra?.collection).toBe("customers");
      expect((err as { extra?: Record<string, unknown> }).extra?.db).toBe(
        "ninox_orm_schema_complex",
      );
    }
  });

  test("rejects invalid enum value", async () => {
    const { db } = ctx;
    await expect(
      db.insertOne("customers", { ...validCustomer(), tier: "legend" } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("rejects strings over maxLength", async () => {
    const { db } = ctx;
    await expect(
      db.insertOne("customers", {
        ...validCustomer(),
        profile: { ...validCustomer().profile, name: "x".repeat(81) },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("rejects strings under minLength", async () => {
    const { db } = ctx;
    await expect(
      db.insertOne("reviews", {
        productId: new ObjectId(),
        customerId: new ObjectId(),
        rating: 4,
        title: "T",
        body: "ab",
        verified: true,
        createdAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("rejects pattern mismatches (sku / trackingNumber)", async () => {
    const { db } = ctx;
    await expect(
      db.insertOne("products", { ...validProduct(), sku: "not-a-sku" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      db.insertOne("shipments", {
        orderId: new ObjectId(),
        carrier: "ups",
        trackingNumber: "!!",
        events: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("rejects numbers out of range and fractional ints", async () => {
    const { db } = ctx;
    await expect(db.insertOne("products", { ...validProduct(), price: -1 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(db.insertOne("products", { ...validProduct(), stock: 1.5 })).rejects.toMatchObject(
      { code: "VALIDATION_FAILED" },
    );
    await expect(
      db.insertOne("reviews", {
        productId: new ObjectId(),
        customerId: new ObjectId(),
        rating: 9,
        title: "T",
        body: "long enough",
        verified: true,
        createdAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("rejects unknown keys when additionalProperties:false", async () => {
    const { db } = ctx;
    const c = validCustomer();
    c.profile.address = { ...c.profile.address, extra: "nope" } as typeof c.profile.address;
    await expect(db.insertOne("customers", c)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("rejects array items missing required fields", async () => {
    const { db, seed } = ctx;
    const o = validOrder(seed.customerIds[0]!);
    // drop qty from the first item
    o.items = [{ sku: "ZZ9999", name: "Item", unitPrice: 1 }] as unknown as typeof o.items;
    await expect(db.insertOne("orders", o)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("rejects invalid array-of-enum items (products.tags)", async () => {
    const { db } = ctx;
    // The type layer would reject 'bogus' at compile time; we cast so the SERVER
    // validator is what rejects it (and the ORM maps it to VALIDATION_FAILED).
    await expect(
      db.insertOne("products", { ...validProduct(), tags: ["bogus"] } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("unique index violation → DUPLICATE_KEY with keyValue context", async () => {
    const { db } = ctx;
    try {
      await db.insertOne("products", { ...validProduct(), sku: "AB0000" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      expect((err as { code?: string }).code).toBe("DUPLICATE_KEY");
      expect((err as { extra?: Record<string, unknown> }).extra?.keyValue).toMatchObject({
        sku: "AB0000",
      });
    }
  });

  test("defaulted fields are optional server-side — `prefs: {}` passes validation", async () => {
    const { db } = ctx;
    // newsletter/locale have defaults in the DSL → not required by the validator
    const c = validCustomer();
    c.prefs = {} as typeof c.prefs;
    const res = await db.insertOne("customers", c);
    expect(res.insertedId).toBeInstanceOf(ObjectId);
  });

  test("updateSchema (collMod) hot-swaps the validator", async () => {
    const { db } = ctx;
    // Original customers schema has no `ssn`. Add it as required via collMod.
    const strict = s.object(
      { ...customerSchema.properties, ssn: s.string() },
      { name: "customers" },
    );
    await db.updateSchema("customers", strict);

    // old-shape doc now fails (no ssn) — routed through the ORM so the error maps
    await expect(db.insertOne("customers", validCustomer())).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    // new-shape doc passes (ssn added — cast past the type layer)
    const res = await db.insertOne("customers", {
      ...validCustomer(),
      ssn: "123-45-6789",
    } as never);
    expect(res.insertedId).toBeInstanceOf(ObjectId);

    // restore the original validator so later tests aren't affected
    await db.updateSchema("customers", customerSchema);
  });
});

/**
 * Schema-drift hardening suite.
 *
 * Unit: the runtime `validateDoc` checker (every DSL field kind + ORM-reserved
 * fields + `additionalProperties`), the keyset `tag()` guard against unsupported
 * value types, and `errInfo` surfacing on VALIDATION_FAILED (single + bulk).
 *
 * Integration (real Mongo): documents written with `bypassDocumentValidation`
 * (drift) are read back through the ORM and asserted to either log (`report`),
 * throw `SCHEMA_DRIFT` (`throw`), or be skipped (per-op `off` / projected
 * reads). Also covers: validation-on-fetch-only (cache hits don't re-log),
 * afterRead hooks can't poison the cache, `paginateFlexible` drift, 121
 * `errInfo` via an ORM write, mixed/null enums accepted server-side, and
 * keyset pagination failing loudly on a drifted sort value.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Decimal128, type Document, ObjectId } from "mongodb";
import {
  BadRequest,
  type DomainError,
  extractValidationPaths,
  isDomainError,
  mapMongoDriverError,
} from "../src/errors/index.ts";
import type { HookContext } from "../src/hooks/hooks.ts";
import { type DriftIssue, s, validateDoc } from "../src/schema/index.ts";
import type { ObjectField } from "../src/schema/types.ts";
import { createMongoService, type MongoService } from "../src/service/index.ts";
import { encodeCursor } from "../src/shared/keyset.ts";
import {
  captureLogger,
  closeService,
  makeEnterpriseService,
  maybeDescribe,
  probe,
} from "./helpers.ts";

/* ----------------------------- unit: validateDoc ----------------------------- */

const issues = (schema: ObjectField, doc: Document): DriftIssue[] => validateDoc(schema, doc);
const codes = (schema: ObjectField, doc: Document): Array<[string, string]> =>
  issues(schema, doc).map((i) => [i.path, i.code]);

describe("validateDoc — field kinds", () => {
  test("string: type + length + pattern", () => {
    const schema = s.object({
      a: s.string(),
      min: s.string({ minLength: 3 }),
      max: s.string({ maxLength: 2 }),
      pat: s.string({ pattern: "^[A-Z]+$" }),
    });
    expect(issues(schema, { a: "ok", min: "abc", max: "ab", pat: "ABC" })).toEqual([]);
    expect(codes(schema, { a: 5, min: "ab", max: "abc", pat: "abc1" })).toEqual([
      ["a", "type"],
      ["min", "constraint"],
      ["max", "constraint"],
      ["pat", "constraint"],
    ]);
  });

  test("number/integer: type + integer-ness + bounds", () => {
    const schema = s.object({
      i: s.integer(),
      iMin: s.integer({ minimum: 0 }),
      iMax: s.integer({ maximum: 10 }),
      n: s.number({ minimum: 0 }),
    });
    expect(issues(schema, { i: 3, iMin: 5, iMax: 10, n: 1.5 })).toEqual([]);
    expect(codes(schema, { i: 1.5, iMin: -1, iMax: 11, n: "x" })).toEqual([
      ["i", "type"],
      ["iMin", "constraint"],
      ["iMax", "constraint"],
      ["n", "type"],
    ]);
  });

  test("boolean / date / objectId / null / any", () => {
    const schema = s.object({
      b: s.boolean(),
      d: s.date(),
      oid: s.objectId(),
      n: s.null(),
      anything: s.any(),
    });
    expect(
      issues(schema, {
        b: true,
        d: new Date(),
        oid: new ObjectId(),
        n: null,
        anything: { deep: [1] },
      }),
    ).toEqual([]);
    expect(codes(schema, { b: 0, d: "2020-01-01", oid: "abc", n: 0, anything: "free" })).toEqual([
      ["b", "type"],
      ["d", "type"],
      ["oid", "type"],
      ["n", "type"],
    ]);
  });

  test("geoPoint: shape + coordinate constraints", () => {
    const schema = s.object({ g: s.geoPoint() });
    expect(issues(schema, { g: { type: "Point", coordinates: [12.5, -30.1] } })).toEqual([]);
    expect(codes(schema, { g: { type: "LineString", coordinates: [1, 2] } })).toEqual([
      ["g", "enum"],
    ]);
    expect(codes(schema, { g: { type: "Point", coordinates: [1] } })).toEqual([
      ["g", "constraint"],
    ]);
    expect(codes(schema, { g: "nope" })).toEqual([["g", "type"]]);
  });

  test("enum: value set is the sole constraint (mixed/null members accepted)", () => {
    const schema = s.object({
      flag: s.enum(["a", 1, null] as unknown as readonly (string | number)[]),
    });
    expect(issues(schema, { flag: "a" })).toEqual([]);
    expect(issues(schema, { flag: 1 })).toEqual([]);
    expect(issues(schema, { flag: null })).toEqual([]);
    expect(codes(schema, { flag: 2 })).toEqual([["flag", "enum"]]);
    expect(codes(schema, { flag: "x" })).toEqual([["flag", "enum"]]);
  });

  test("array: type + per-item validation (incl. nested objects)", () => {
    const schema = s.object({
      tags: s.array(s.string()),
      items: s.array(s.object({ sku: s.string(), qty: s.integer({ minimum: 1 }) })),
    });
    expect(issues(schema, { tags: ["a"], items: [{ sku: "AB1234", qty: 2 }] })).toEqual([]);
    expect(codes(schema, { tags: "nope", items: "nope" })).toEqual([
      ["tags", "type"],
      ["items", "type"],
    ]);
    expect(codes(schema, { tags: ["a", 1], items: [{ sku: "AB1234" }] })).toEqual([
      ["tags[1]", "type"],
      ["items[0].qty", "missing"],
    ]);
  });

  test("object: nested required/unknown-key handling + additionalProperties opt-out", () => {
    const strict = s.object({
      profile: s.object(
        { address: s.object({ street: s.string() }, { additionalProperties: false }) },
        { additionalProperties: false },
      ),
    });
    expect(issues(strict, { profile: { address: { street: "s" } } })).toEqual([]);
    expect(codes(strict, { profile: { address: { street: "s", zip: "1" } } })).toEqual([
      ["profile.address.zip", "unknown_key"],
    ]);
    expect(codes(strict, { profile: {}, extra: 1 })).toEqual([
      ["profile.address", "missing"],
      ["extra", "unknown_key"],
    ]);

    const loose = s.object(
      { profile: s.object({ known: s.string() }) },
      { additionalProperties: true },
    );
    expect(issues(loose, { profile: { known: "x" }, extraField: 1 })).toEqual([]);
  });

  test("reserved ORM lifecycle fields (_id/__v/deletedAt) are type-checked, not unknown", () => {
    const schema = s.object({ name: s.string() });
    expect(
      issues(schema, { name: "x", _id: new ObjectId(), __v: 1, deletedAt: new Date() }),
    ).toEqual([]);
    expect(issues(schema, { name: "x", deletedAt: null })).toEqual([]);
    expect(codes(schema, { name: "x", _id: "abc", __v: "nope", deletedAt: "soon" })).toEqual([
      ["_id", "type"],
      ["__v", "type"],
      ["deletedAt", "type"],
    ]);
  });

  test("missing required vs optional/default fields", () => {
    const schema = s.object({
      req: s.string(),
      opt: s.string().optional(),
      def: s.integer({ minimum: 0 }).default(5),
    });
    expect(issues(schema, { req: "x" })).toEqual([]);
    expect(codes(schema, {})).toEqual([["req", "missing"]]);
  });

  test("non-object document is a type drift", () => {
    const schema = s.object({ name: s.string() });
    expect(codes(schema, "nope" as unknown as Document)).toEqual([["", "type"]]);
    expect(codes(schema, [1] as unknown as Document)).toEqual([["", "type"]]);
  });

  test("strict BSON numeric kinds + multipleOf/exclusive bounds", () => {
    const schema = s.object({
      d: s.double({ multipleOf: 0.5 }),
      l: s.long(),
      dec: s.decimal(),
      step: s.number({ minimum: 0, exclusiveMinimum: true, multipleOf: 10 }),
    });
    expect(issues(schema, { d: 1.5, l: 5, dec: new Decimal128("12.34"), step: 20 })).toEqual([]);
    expect(codes(schema, { d: "x", l: 1.5, dec: "nope", step: 5 })).toEqual([
      ["d", "type"],
      ["l", "type"],
      ["dec", "type"],
      ["step", "constraint"],
    ]);
  });

  test("array minItems/maxItems/uniqueItems are drift-checked", () => {
    const schema = s.object({
      codes: s.array(s.string(), { minItems: 1, maxItems: 2, uniqueItems: true }),
    });
    expect(issues(schema, { codes: ["a"] })).toEqual([]);
    expect(codes(schema, { codes: [] })).toEqual([["codes", "constraint"]]);
    expect(codes(schema, { codes: ["a", "b", "c"] })).toEqual([["codes", "constraint"]]);
    expect(codes(schema, { codes: ["a", "a"] })).toEqual([["codes", "constraint"]]);
  });

  test("object minProperties/maxProperties are drift-checked", () => {
    const schema = s.object({
      obj: s.object(
        { a: s.string().optional(), b: s.string().optional() },
        { minProperties: 2, maxProperties: 2, additionalProperties: true },
      ),
    });
    expect(issues(schema, { obj: { a: "x", b: "y" } })).toEqual([]);
    expect(codes(schema, { obj: { a: "x" } })).toEqual([["obj", "constraint"]]);
    expect(codes(schema, { obj: { a: "x", b: "y", c: "z" } })).toEqual([["obj", "constraint"]]);
  });

  test("raw $jsonSchema fields are not re-checked on the read side", () => {
    const schema = s.object({ meta: s.jsonSchema({ bsonType: "object" }) });
    expect(issues(schema, { meta: { anything: true } })).toEqual([]);
  });
});

/* ----------------------------- unit: keyset tag() ----------------------------- */

describe("keyset tag() — unsupported (drifted) value types", () => {
  test("object sort values fail loudly instead of lossy encoding", () => {
    expect(() => encodeCursor({ sort: { name: 1 }, values: [{ x: 1 }] })).toThrow(BadRequest);
  });
  test("array sort values fail loudly", () => {
    expect(() => encodeCursor({ sort: { tags: 1 }, values: [[1, 2]] })).toThrow(BadRequest);
  });
});

/* ----------------------------- unit: errInfo surfacing ----------------------------- */

describe("VALIDATION_FAILED errInfo (code 121)", () => {
  test("extractValidationPaths flattens property names (deduped)", () => {
    expect(
      extractValidationPaths({
        details: {
          schemaRulesNotSatisfied: [
            {
              propertiesNotSatisfied: [{ propertyName: "email" }, { propertyName: "profile.name" }],
            },
            { propertyName: "profile", propertiesNotSatisfied: [{ propertyName: "profile.name" }] },
            { additionalProperties: ["_id", "rogue"] },
          ],
        },
      }),
    ).toEqual(["email", "profile.name", "profile", "_id", "rogue"]);
  });

  test("121 → DomainError VALIDATION_FAILED with fields + documentId", () => {
    const err = mapMongoDriverError({
      name: "MongoServerError",
      code: 121,
      message: "Document failed validation",
      errInfo: {
        failingDocumentId: new ObjectId("65f0c2b8a1b2c3d4e5f6a7b8"),
        details: {
          schemaRulesNotSatisfied: [
            {
              propertiesNotSatisfied: [{ propertyName: "email" }, { propertyName: "profile.name" }],
            },
          ],
        },
      },
    } as unknown as Error);
    expect(isDomainError(err)).toBe(true);
    const e = err as DomainError;
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.extra?.fields).toEqual(["email", "profile.name"]);
    expect(e.extra?.documentId).toEqual(new ObjectId("65f0c2b8a1b2c3d4e5f6a7b8"));
  });

  test("bulk-write 121 → VALIDATION_FAILED with fields", () => {
    const err = mapMongoDriverError({
      name: "MongoBulkWriteError",
      writeErrors: [
        {
          code: 121,
          errmsg: "Document failed validation",
          errInfo: {
            details: {
              schemaRulesNotSatisfied: [{ propertiesNotSatisfied: [{ propertyName: "qty" }] }],
            },
          },
        },
      ],
    } as unknown as Error);
    expect(isDomainError(err)).toBe(true);
    const e = err as DomainError;
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.extra?.fields).toContain("qty");
  });

  test("non-121 / no errInfo falls through unchanged", () => {
    const err = mapMongoDriverError({
      name: "MongoServerError",
      code: 50,
      message: "timeout",
    } as unknown as Error);
    expect((err as DomainError).code).toBe("MONGO_TIMEOUT");
    expect((err as DomainError).extra?.fields).toBeUndefined();
  });
});

/* ----------------------------- integration: real Mongo ----------------------------- */

const available = await probe();
const maybe = maybeDescribe(available);
const cap2 = captureLogger();

/** A customers doc that is missing a required field AND carries an unknown key. */
const driftedCustomer = (email = "drift@example.com"): Document => ({
  email,
  profile: {
    name: "Drifted",
    address: {
      street: "1 Drift Ave",
      city: "Nowhere",
      country: "XX",
      geo: { lat: 1, lng: 2 },
    },
  },
  tier: "gold",
  priority: 2,
  tags: [],
  prefs: { newsletter: true, locale: "en-US" },
  // createdAt (required) intentionally omitted → drift
  rogueField: "not-in-schema", // unknown key → drift
});

maybe("document drift — read-path hardening (real Mongo)", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;
  const cap = captureLogger();

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_orm_drift", {
      logger: cap.logger,
      wrapMongoErrors: true,
    });
    // Simulate drift from outside the ORM (older version / other service / raw driver).
    await ctx.db.client
      .collection("customers")
      .insertOne(driftedCustomer(), { bypassDocumentValidation: true } as never);
  });

  afterAll(async () => {
    await closeService(ctx);
  });

  test("default 'report': drifted doc returned as-is + warn names the offending fields", async () => {
    const before = cap.warns.length;
    const doc = await ctx.db.getOne("customers", { email: "drift@example.com" } as never);
    expect(doc?.email).toBe("drift@example.com");
    expect(cap.warns.length).toBe(before + 1);
    const warn = cap.warns[cap.warns.length - 1]!;
    expect(warn.msg).toContain("[drift]");
    expect(warn.obj?.collection).toBe("customers");
    const driftIssues = warn.obj?.issues as DriftIssue[];
    expect(driftIssues.some((i) => i.path === "createdAt" && i.code === "missing")).toBe(true);
    expect(driftIssues.some((i) => i.path === "rogueField" && i.code === "unknown_key")).toBe(true);
  });

  test("validation runs on DB fetch only — cache hits do NOT re-log", async () => {
    const before = cap.warns.length;
    // First read was a miss (logged); this second identical read is a cache hit.
    const doc = await ctx.db.getOne("customers", { email: "drift@example.com" } as never);
    expect(doc?.email).toBe("drift@example.com");
    expect(cap.warns.length).toBe(before);
  });

  test("per-op 'throw': drifted doc throws SCHEMA_DRIFT and is never cached", async () => {
    const read = () =>
      ctx.db.getOne("customers", { email: "drift@example.com" } as never, { drift: true });
    await expect(read()).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
    // Nothing was cached under this key (throw happens before cache.set), so a
    // retry re-fetches and re-throws rather than serving a stale success.
    await expect(read()).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });

  test("per-op 'off': skips drift checking entirely (no warn)", async () => {
    const before = cap.warns.length;
    const doc = await ctx.db.getOne("customers", { email: "drift@example.com" } as never, {
      drift: false,
    });
    expect(doc?.email).toBe("drift@example.com");
    expect(cap.warns.length).toBe(before);
  });

  test("projected reads are skipped (partial docs would false-positive)", async () => {
    // A throw-mode read with a projection must NOT throw on the missing required
    // fields — the projection returns only _id + email.
    const doc = await ctx.db.getOne("customers", { email: "drift@example.com" } as never, {
      drift: true,
      select: ["email"] as never,
    });
    expect(doc?.email).toBe("drift@example.com");
  });

  test("findMany + findActive also detect drift", async () => {
    const before = cap.warns.length;
    const docs = await ctx.db.findMany("customers", { email: "drift@example.com" } as never);
    expect(docs.length).toBe(1);
    expect(cap.warns.length).toBe(before + 1);
    const active = await ctx.db.findActive("customers", { email: "drift@example.com" } as never);
    expect(active.length).toBe(1);
    expect(cap.warns.length).toBe(before + 2);
  });

  test("paginateFlexible detects drift in the returned page", async () => {
    const before = cap.warns.length;
    const page = await ctx.db.paginateFlexible(
      "customers",
      { email: "drift@example.com" } as never,
      { page: 1, limit: 10 },
    );
    expect(page.data.length).toBe(1);
    const driftWarn = cap.warns.slice(before).find((w) => w.obj?.op === "mongo.paginateFlexible");
    expect(driftWarn).toBeDefined();
  });

  test("ORM write violating the schema → VALIDATION_FAILED names fields + documentId", async () => {
    // Otherwise-valid doc (createdAt included) + ONE unknown key, so the only
    // violating rule is the top-level additionalProperties:false check.
    const valid = { ...driftedCustomer("rogue@example.com"), createdAt: new Date() } as Record<
      string,
      unknown
    >;
    delete valid.rogueField;
    try {
      await (ctx.db.insertOne as (c: string, doc: Document) => Promise<unknown>)("customers", {
        ...valid,
        rogue: 1,
      });
      throw new Error("expected insertOne to reject");
    } catch (err) {
      expect((err as DomainError).code).toBe("VALIDATION_FAILED");
      const extra = (err as DomainError).extra ?? {};
      expect(extra.fields).toContain("rogue");
      expect(extra.documentId).toBeDefined();
    }
  });
});

maybe("document drift — enum union + keyset guard (real Mongo)", () => {
  // A focused service: a MIXED enum (string + int) and a clean object for the
  // keyset boundary test.
  const mixedSchema = s.object({
    _id: s.objectId(),
    flag: s.enum(["a", 1] as const),
    name: s.string(),
    count: s.integer({ minimum: 0 }),
    tags: s.array(s.string()),
    meta: s.object({ note: s.string() }),
  });
  const hookedSchema = s.object({
    _id: s.objectId(),
    name: s.string(),
    note: s.string().optional(),
  });
  const hooked = {
    schema: hookedSchema,
    hooks: {
      // Increment `seen` on whatever doc it receives. If the shared cache entry
      // were poisoned, a later read would start from `seen: 1` and bump to 2.
      afterRead: (hctx: HookContext) => {
        const d = hctx.doc as Document;
        d.seen = ((d.seen as number | undefined) ?? 0) + 1;
      },
    },
  };
  const keysetSchema = s.object({
    _id: s.objectId(),
    name: s.string(),
  });

  type FocusClients = {
    primary: {
      name: string;
      dbUrl: string;
      collections: {
        mixed: typeof mixedSchema;
        hooked: typeof hooked;
        keyset: typeof keysetSchema;
      };
    };
  };
  type FocusManager = MongoService<FocusClients>["db"]["primaryClient"];

  let service: MongoService<FocusClients>;
  let db: FocusManager;

  beforeAll(async () => {
    service = createMongoService<FocusClients>(
      {
        primary: {
          name: "ninox_orm_drift_focus",
          dbUrl: process.env.MONGO_URL ?? "mongodb://admin:admin@localhost:27017/",
          collections: { mixed: mixedSchema, hooked, keyset: keysetSchema },
        },
      },
      { logger: cap2.logger, wrapMongoErrors: true },
    );
    await service.makeConnections();
    db = service.db.primaryClient;
    // Idempotency: a prior run may have left the collections behind.
    for (const c of ["mixed", "hooked", "keyset"]) {
      await db.client.dropCollection(c).catch(() => {});
      await db.createSchema(c);
    }
  });

  afterAll(async () => {
    await closeService({ service });
  });

  test("mixed enum: every member passes server validation; out-of-set is rejected", async () => {
    const base = { name: "n", count: 0, tags: [], meta: { note: "x" } };
    await expect(db.insertOne("mixed", { ...base, flag: 1 } as never)).resolves.toBeDefined();
    await expect(db.insertOne("mixed", { ...base, flag: "a" } as never)).resolves.toBeDefined();
    await expect(db.insertOne("mixed", { ...base, flag: 2 } as never)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  test("afterRead hooks cannot poison the shared cache entry", async () => {
    await db.insertOne("hooked", { name: "hooky", note: "n" } as never);
    const first = await db.getOne("hooked", { name: "hooky" } as never);
    // First read is a cache miss → the hook runs on a fresh clone of the cached
    // doc → the caller sees its own `seen: 1`.
    expect((first as Document).seen).toBe(1);
    // Second read is a cache HIT. If the shared cache entry had been poisoned by
    // the first hook, this clone would start at `seen: 1` and bump to 2. Instead
    // the cache stays pristine, so each caller gets a fresh `seen: 1`.
    const second = await db.getOne("hooked", { name: "hooky" } as never);
    expect((second as Document).seen).toBe(1);
    // Different object identity per read → no shared (mutated) cache object.
    expect(first).not.toBe(second);
    expect(second?.name).toBe("hooky");
  });

  test("keyset pagination fails loudly on a drifted sort value", async () => {
    // Exactly two docs: one valid string `name`, one drifted object `name`
    // (bypasses the server validator). In DESCENDING order the object sorts
    // first, so it lands IN the page and becomes the boundary; encoding its
    // cursor must throw instead of silently corrupting pagination.
    await db.insertOne("keyset", { name: "aa" } as never);
    await db.client
      .collection("keyset")
      .insertOne({ _id: new ObjectId(), name: { x: 1 } }, { bypassDocumentValidation: true });
    await expect(
      db.paginateCursor("keyset", {}, { sort: { name: -1 }, limit: 1 }),
    ).rejects.toBeInstanceOf(BadRequest);
  });
});

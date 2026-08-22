/**
 * Type-level assertions for schema-driven type-safety.
 *
 * This file is compiled by `bun run typecheck` (tsc --noEmit) — it is NOT
 * executed by the test runner (it has no runtime assertions). Every
 * `@ts-expect-error` MUST stay an error; an unused directive fails typecheck,
 * so this file proves both the positive (typed) and negative (rejected)
 * sides of the type system.
 */
import { Decimal128, ObjectId } from "mongodb";
import {
  belongsTo,
  createMongoService,
  createRepository,
  defineCollection,
  defineCollections,
  hasMany,
  type InferDoc,
  manyToMany,
  s,
} from "../src/index.ts";

const userSchema = s.object(
  { _id: s.objectId(), email: s.string(), name: s.string().optional() },
  { name: "users" },
);
type User = InferDoc<typeof userSchema>;

const orderSchema = s.object(
  { _id: s.objectId(), userId: s.objectId(), total: s.number() },
  { name: "orders" },
);
type Order = InferDoc<typeof orderSchema>;

const joinSchema = s.object(
  { _id: s.objectId(), orderId: s.objectId(), tagId: s.objectId() },
  { name: "order_tags" },
);

const service = createMongoService({
  primary: {
    name: "types-test",
    dbUrl: "mongodb://localhost:27017/",
    collections: { users: userSchema, orders: orderSchema, order_tags: joinSchema },
  },
});

declare const orders: Awaited<ReturnType<typeof service.db.primaryClient.findMany<"orders">>>;
declare const manager: typeof service.db.primaryClient;

const _t = async (): Promise<void> => {
  /* ---------------------- registry: names derive from schemas ---------------------- */
  const collections = defineCollections(userSchema, orderSchema, joinSchema);
  // @ts-expect-error — the derived map is keyed by schema names, not arbitrary strings
  const badKey: keyof typeof collections = "nope";
  // @ts-expect-error — a nameless schema cannot be registered (no name to key by)
  defineCollections(s.object({ a: s.string() }));
  // (duplicate names are a runtime error — `defineCollections` throws)

  // defineCollection convenience + registry
  const products = defineCollection("products", s.object({ sku: s.string(), price: s.number() }), {
    indexes: [{ key: { sku: 1 }, options: { unique: true } }],
  });
  const map = defineCollections(userSchema, products);
  // @ts-expect-error — keyed by 'products', not 'nope'
  const badMapKey: keyof typeof map = "nope";

  /* ---------------------- doc types are precise ---------------------- */
  // @ts-expect-error — 'nope' is not a field of User
  const _k: keyof User = "nope";
  // @ts-expect-error — number is not assignable to the email string field
  const _e: User["email"] = 123;

  /* ---------------------- CRUD: collection-name typing ---------------------- */
  // @ts-expect-error — 'nope' is not a known collection
  manager.getOne("nope", {});
  // (filter/insert/update/select fields are now checked against the schema via
  //  strict `FilterInput` / `InsertInput` / `UpdateInput` — see below.)

  /* ---------------------- strict inserts ---------------------- */
  // positive: required fields present, `_id` optional at insert time
  manager.insertOne("users", { email: "a@b.c" });
  manager.insertOne("users", { email: "a@b.c", name: "Ada" });
  manager.insertMany("users", [{ email: "a@b.c" }, { email: "b@c.d" }]);
  // @ts-expect-error — email is a string, not a number
  manager.insertOne("users", { email: 123 });
  // @ts-expect-error — 'nope' is not a field of User
  manager.insertOne("users", { email: "a@b.c", nope: 1 });
  // @ts-expect-error — email is required
  manager.insertOne("users", {});
  // @ts-expect-error — array items are checked too
  manager.insertMany("users", [{ email: 123 }]);

  /* ---------------------- strict filters ---------------------- */
  manager.getOne("users", { email: "a@b.c" });
  manager.getOne("users", { _id: { $in: [] } });
  manager.findMany("orders", { total: { $gte: 5 } });
  // @ts-expect-error — 'nope' is not a field of User
  manager.getOne("users", { nope: 1 });
  // @ts-expect-error — a typo'd filter field is rejected
  manager.query("users").where({ emial: "x" });

  /* ---------------------- strict updates ---------------------- */
  manager.updateOne("users", { email: "a@b.c" }, { $set: { name: "Ada" } });
  manager.updateOne("users", { email: "a@b.c" }, { name: "Ada" }); // plain patch → $set
  // @ts-expect-error — unknown plain-patch key is rejected (excess property check)
  manager.updateOne("users", {}, { nope: 1 });
  const badPatch = { nope: 1 };
  // @ts-expect-error — unknown key in a NON-literal plain patch is rejected too
  manager.updateOne("users", {}, badPatch);
  const badSet = { nope: 1 };
  // @ts-expect-error — unknown key in a NON-literal $set is rejected too
  manager.updateOne("users", {}, { $set: badSet });
  manager.updateOne("orders", { total: 5 }, { $inc: { total: 1 } });
  // @ts-expect-error — $set value type is wrong
  manager.updateOne("users", {}, { $set: { email: 123 } });
  // @ts-expect-error — unknown $set key
  manager.updateOne("users", {}, { $set: { nope: 1 } });
  // @ts-expect-error — $inc value must be numeric
  manager.updateOne("orders", {}, { $inc: { total: "x" } });

  /* ---------------------- strict select / replace ---------------------- */
  manager.findMany("users", {}, { select: ["_id", "email"] });
  // @ts-expect-error — 'nope' is not a field of User
  manager.findMany("users", {}, { select: ["nope"] });
  // @ts-expect-error — replacement must include the required _id
  manager.findOneAndReplace("users", {}, { email: "x" });

  /* ---------------------- query builder: collection typing + toggles ---------------------- */
  // @ts-expect-error — unknown collection
  manager.query("nope");
  // per-op perf toggles type-check
  manager.query("users").where({ email: "x" }).cache(false).dedupe(false).one();
  manager.findMany("users", {}, { cache: false, dedupe: false });
  // find queries support a field-list `select` (translated to a projection)
  manager.findMany("users", {}, { select: ["_id", "email"] });
  manager.getOne("users", { email: "a@b.c" }, { select: ["email"] });
  manager.findActive("users", {}, { select: ["email"] });
  manager.findActiveOne("users", { email: "a@b.c" }, { select: ["email"] });

  /* ---------------------- populate: typed results + validated config ---------------------- */
  const populated = await manager.populate(orders, [
    belongsTo({ collection: "users", localField: "userId", as: "customer" }),
    hasMany({ collection: "orders", localField: "userId", as: "more" }),
    manyToMany({
      collection: "users",
      localField: "_id",
      as: "tags",
      through: { collection: "order_tags", localField: "orderId", foreignField: "tagId" },
    }),
  ]);
  const customer: User | null = populated[0]?.customer ?? null;
  const more: Order[] = populated[0]?.more ?? [];
  const tags: User[] = populated[0]?.tags ?? [];
  void customer;
  void more;
  void tags;
};

const _bad = (): void => {
  // @ts-expect-error — unknown collection in populate
  manager.populate(orders, [belongsTo({ collection: "nope", localField: "userId", as: "x" })]);
  // @ts-expect-error — bad localField on the source doc
  manager.populate(orders, [belongsTo({ collection: "users", localField: "nope", as: "x" })]);
  // @ts-expect-error — bad foreignField on the target doc
  manager.populate(orders, [
    belongsTo({ collection: "users", localField: "userId", foreignField: "nope", as: "x" }),
  ]);
  // @ts-expect-error — bad hasMany localField
  manager.populate(orders, [hasMany({ collection: "orders", localField: "nope", as: "x" })]);
  // @ts-expect-error — bad manyToMany through collection
  manager.populate(orders, [
    manyToMany({
      collection: "users",
      localField: "_id",
      as: "x",
      through: { collection: "nope", localField: "orderId", foreignField: "tagId" },
    }),
  ]);
  // @ts-expect-error — bad manyToMany through foreignField
  manager.populate(orders, [
    manyToMany({
      collection: "users",
      localField: "_id",
      as: "x",
      through: { collection: "order_tags", localField: "orderId", foreignField: "nope" },
    }),
  ]);
};

/* ---------------------- typed aggregation pipeline ---------------------- */
const _pipe = async (): Promise<void> => {
  /* result type is inferred through the chain */
  const byUser = await manager
    .pipeline("orders")
    .match({ total: { $gte: 10 } })
    .group({ _id: "$userId", revenue: { $sum: "$total" }, count: { $sum: 1 } })
    .sort({ revenue: -1 })
    .limit(5)
    .toArray();
  const _gId: Order["userId"] | undefined = byUser[0]?._id;
  const _rev: number | undefined = byUser[0]?.revenue;
  const _cnt: number | undefined = byUser[0]?.count;
  // @ts-expect-error — `total` was grouped away
  byUser[0]?.total;

  /* project include/exclude recomputes the shape */
  const projected = await manager.pipeline("users").project({ email: 1 }).toArray();
  const _pEmail: User["email"] | undefined = projected[0]?.email;
  const _pId: User["_id"] | undefined = projected[0]?._id;
  // @ts-expect-error — `name` was excluded by the inclusion projection
  projected[0]?.name;

  /* $lookup sub-pipeline is scoped to the foreign collection */
  const joined = await manager
    .pipeline("users")
    .lookup({
      from: "orders",
      localField: "_id",
      foreignField: "userId",
      as: "orders",
      pipeline: (o) => o.match({ total: { $gte: 5 } }).project({ total: 1 }),
    })
    .toArray();
  const _orderTotal: number | undefined = joined[0]?.orders[0]?.total;
  // @ts-expect-error — `email` was projected away inside the sub-pipeline
  joined[0]?.orders[0]?.email;

  /* $lookup without a sub-pipeline types `as` as the foreign doc array */
  const plain = await manager
    .pipeline("users")
    .lookup({ from: "orders", localField: "_id", foreignField: "userId", as: "orders" })
    .unwind("$orders")
    .toArray();
  const _unwound: Order | undefined = plain[0]?.orders;

  /* $facet branches each get their own typed sub-builder */
  const faceted = await manager
    .pipeline("orders")
    .facet({
      byUser: (s) => s.group({ _id: "$userId", count: { $sum: 1 } }),
      top: (s) => s.sort({ total: -1 }).limit(5),
    })
    .toArray();
  const _fCount: number | undefined = faceted[0]?.byUser[0]?.count;
  const _fTotal: number | undefined = faceted[0]?.top[0]?.total;
  // @ts-expect-error — `byUser` is a grouped shape, it has no `total`
  faceted[0]?.byUser[0]?.total;

  /* addFields retains the input and adds computed fields */
  const withTax = await manager
    .pipeline("orders")
    .addFields({ totalWithTax: { $multiply: ["$total", 1.1] } })
    .toArray();
  const _tax: unknown = withTax[0]?.totalWithTax;
  const _tot: number | undefined = withTax[0]?.total;

  /* count + first terminals */
  const counts = await manager.pipeline("orders").count("total").toArray();
  const _n: number | undefined = counts[0]?.total;
  const one = await manager.pipeline("orders").sort({ total: -1 }).first();
  const _oneTotal: number | undefined = one?.total;

  /* typed callback aggregate() stages + typed lookup sub-pipeline */
  const cbCursor = await manager.aggregate("orders", (stages) => [
    stages.match({ total: { $gte: 1 } }),
    stages.group({ _id: "$userId", revenue: { $sum: "$total" } }),
    stages.sort({ revenue: -1 }),
    stages.limit(3),
  ]);
  const cb = await cbCursor.toArray();
  void cb;
  manager.aggregate("users", (stages) => [
    stages.match({ email: { $regex: ".*" } }),
    stages.lookup({
      from: "orders",
      localField: "_id",
      foreignField: "userId",
      as: "orders",
      pipeline: (o) => o.match({ total: { $gte: 1 } }).project({ total: 1 }),
    }),
  ]);
};

const _badPipe = (): void => {
  // @ts-expect-error — unknown collection
  manager.pipeline("nope");
  // @ts-expect-error — match on an undeclared field
  manager.pipeline("orders").match({ nope: 1 });
  // @ts-expect-error — group _id is not a real field
  manager.pipeline("orders").group({ _id: "nope", count: { $sum: 1 } });
  // @ts-expect-error — lookup from an unknown collection
  manager.pipeline("users").lookup({ from: "nope", localField: "_id", as: "x" });
  // @ts-expect-error — lookup localField is not on the source doc
  manager.pipeline("users").lookup({ from: "orders", localField: "nope", as: "x" });
  // @ts-expect-error — lookup foreignField is not on the foreign doc
  manager
    .pipeline("users")
    .lookup({ from: "orders", localField: "_id", foreignField: "nope", as: "x" });
};

/* ------------------ enterprise complex schema + pipelines ------------------ */
import {
  type Customer as EntCustomer,
  type Order as EntOrder,
  type Product as EntProduct,
  enterpriseCollections,
} from "./fixtures/enterprise.ts";

const entService = createMongoService({
  primary: {
    name: "types-enterprise",
    dbUrl: "mongodb://localhost:27017/",
    collections: enterpriseCollections,
  },
});
declare const entManager: typeof entService.db.primaryClient;

declare const entCustomer: EntCustomer;
declare const entOrder: EntOrder;
declare const entProduct: EntProduct;

const _ent = async (): Promise<void> => {
  /* deep nested precision (object-in-array-in-object) */
  const _lat: number = entCustomer.profile.address.geo.lat;
  const _lng: number = entCustomer.profile.address.geo.lng;
  const _tier: "bronze" | "silver" | "gold" | "platinum" = entCustomer.tier;
  const _prio: 1 | 2 | 3 = entCustomer.priority;
  const _tag: string | undefined = entCustomer.tags[0];
  const _newsletter: boolean | undefined = entCustomer.prefs.newsletter;
  const _locale: string | undefined = entCustomer.prefs.locale;

  /* array-of-objects element precision */
  const _itemName: string | undefined = entOrder.items[0]?.name;
  const _itemQty: number | undefined = entOrder.items[0]?.qty;
  const _itemDiscount: number | undefined = entOrder.items[0]?.discountPct;
  const _grandTotal: number = entOrder.totals.grandTotal;
  const _city: string = entOrder.billing.address.city;
  const _status: "pending" | "paid" | "shipped" | "cancelled" = entOrder.status;

  /* optional nested object (products.attributes) */
  const _weight: number | undefined = entProduct.attributes?.weightKg;
  const _prodTag: "new" | "sale" | "featured" | "clearance" | undefined = entProduct.tags[0];

  void _lat;
  void _lng;
  void _tier;
  void _prio;
  void _tag;
  void _newsletter;
  void _locale;
  void _itemName;
  void _itemQty;
  void _itemDiscount;
  void _grandTotal;
  void _city;
  void _status;
  void _weight;
  void _prodTag;

  /* typed aggregation: lookup into a nested-shaped collection */
  const joined = await entManager
    .pipeline("orders")
    .lookup({ from: "customers", localField: "customerId", foreignField: "_id", as: "customer" })
    .toArray();
  const _joinedTier: "bronze" | "silver" | "gold" | "platinum" | undefined =
    joined[0]?.customer[0]?.tier;
  const _joinedGeo: number | undefined = joined[0]?.customer[0]?.profile.address.geo.lat;
  void _joinedTier;
  void _joinedGeo;

  /* unwind embedded items then group with compound _id + mixed accumulators */
  const grouped = await entManager
    .pipeline("orders")
    .unwind("$items")
    .group({
      _id: { status: "$status", sku: "$items.sku" },
      qty: { $sum: "$items.qty" },
      avgPrice: { $avg: "$items.unitPrice" },
      skus: { $addToSet: "$items.sku" },
      names: { $push: "$items.name" },
      first: { $first: "$items.name" },
    })
    .toArray();
  const _gQty: number | undefined = grouped[0]?.qty;
  const _gAvg: number | undefined = grouped[0]?.avgPrice;
  const _gSkus: unknown = grouped[0]?.skus;
  void _gQty;
  void _gAvg;
  void _gSkus;

  /* match on a nested array field via $elemMatch */
  const matched = await entManager
    .pipeline("orders")
    .match({ items: { $elemMatch: { sku: "AB0000" } } })
    .toArray();
  void matched;

  /* facet branches with typed sub-builders over the enterprise model */
  const faceted = await entManager
    .pipeline("orders")
    .facet({
      byStatus: (s) => s.group({ _id: "$status", n: { $sum: 1 } }),
      perCustomer: (s) => s.group({ _id: "$customerId", revenue: { $sum: "$totals.grandTotal" } }),
    })
    .toArray();
  const _fN: number | undefined = faceted[0]?.byStatus[0]?.n;
  const _fRev: number | undefined = faceted[0]?.perCustomer[0]?.revenue;
  void _fN;
  void _fRev;
};

const _entBad = (): void => {
  // @ts-expect-error — deep nested field type is enforced
  const badLat: string = entCustomer.profile.address.geo.lat;
  // @ts-expect-error — enum literal union is enforced
  const badTier: EntCustomer["tier"] = "legend";
  // @ts-expect-error — array element type is enforced
  const badQty: EntOrder["items"][number]["qty"] = "two";
  // @ts-expect-error — optional nested field type is enforced
  const badWeight: string = entProduct.attributes?.weightKg ?? "";
  entManager.insertOne("customers", {
    email: "a@b.c",
    profile: {
      name: "N",
      address: {
        street: "s",
        city: "c",
        country: "US",
        // @ts-expect-error — wrong nested shape rejected at insert
        geo: { lat: "x", lng: 0 },
      },
    },
    tier: "gold",
    priority: 1,
    tags: [],
    createdAt: new Date(),
  });
  // @ts-expect-error — unknown collection in enterprise pipeline
  entManager.pipeline("nope");
  // @ts-expect-error — match on an undeclared nested path
  entManager.pipeline("orders").match({ "items.nope": 1 });
  entManager.pipeline("orders").lookup({
    from: "customers",
    localField: "customerId",
    // @ts-expect-error — lookup foreignField not on the nested foreign doc
    foreignField: "nope",
    as: "c",
  });
};

void _t;
void _bad;
void _pipe;
void _badPipe;
void _ent;
void _entBad;

/* ---------------------- new CRUD ops (distinct / parity / bulk) ---------------------- */
const _newCrud = async (): Promise<void> => {
  const totals: number[] = await manager.distinct("orders", "total");
  void totals;
  // @ts-expect-error — distinct field must be a real field of the collection doc
  manager.distinct("orders", "nope");
  manager.estimatedDocumentCount("orders");
  const deleted = await manager.findOneAndDelete("users", { email: "a@b.c" });
  const _deleted: User | null = deleted;
  void _deleted;
  manager.replaceOne("users", { email: "a@b.c" }, { email: "b@c.d" });
  // @ts-expect-error — replacement must include the required email field
  manager.replaceOne("users", { email: "a@b.c" }, {});
  manager.bulkWrite("users", [{ insertOne: { document: { email: "a@b.c" } } }]);
};

/* ---------------------- keyset pagination ---------------------- */
const _keyset = async (): Promise<void> => {
  const page = await manager.paginateCursor(
    "orders",
    {},
    { sort: { total: -1, _id: 1 }, limit: 10 },
  );
  const _data: Order[] = page.data;
  const _cursor: string | null = page.nextCursor;
  const _more: boolean = page.hasMore;
  void _data;
  void _cursor;
  void _more;
  // @ts-expect-error — paginateCursor requires a sort
  manager.paginateCursor("orders", {}, {});
  // @ts-expect-error — unknown collection
  manager.paginateCursor("nope", {}, { sort: { total: -1 } });
};

/* ---------------------- geo: s.geoPoint() + $geoNear ---------------------- */
const placeSchema = s.object({
  _id: s.objectId(),
  name: s.string(),
  location: s.geoPoint(),
});
type Place = InferDoc<typeof placeSchema>;
const _geo = async (): Promise<void> => {
  const _loc: Place["location"] = { type: "Point", coordinates: [-74, 40] };
  void _loc;
  // @ts-expect-error — coordinates must be [number, number]
  const _badLoc: Place["location"] = { type: "Point", coordinates: ["x", 40] };

  const near = await manager
    .pipeline("orders")
    .geoNear({ near: [-74, 40], distanceField: "dist" })
    .toArray();
  const _dist: number | undefined = near[0]?.dist;
  void _dist;
  // @ts-expect-error — near must be a Point or [number, number]
  manager.pipeline("orders").geoNear({ near: [-74], distanceField: "dist" });
};

/* ---------------------- repository ---------------------- */
const _repo = async (): Promise<void> => {
  const users = createRepository(manager, "users");
  const byId: User | null = await users.getById(new ObjectId());
  const byIds: User[] = await users.getByIds([new ObjectId()]);
  const created = await users.create({ email: "a@b.c" });
  void byId;
  void byIds;
  void created;
  // @ts-expect-error — getById expects the doc's _id type
  users.getById(123);
  // @ts-expect-error — repository findMany uses the strict filter
  users.findMany({ nope: 1 });
  // @ts-expect-error — unknown collection for a repository
  createRepository(manager, "nope");
};

void _newCrud;
void _keyset;
void _geo;
void _repo;

/* ---------------------- strict BSON numeric kinds + raw ---------------------- */
const _precise = async (): Promise<void> => {
  const preciseSchema = s.object({
    _id: s.objectId(),
    d: s.double(),
    l: s.long(),
    dec: s.decimal(),
    meta: s.jsonSchema({ bsonType: "object" }),
  });
  type Precise = InferDoc<typeof preciseSchema>;
  const _d: Precise["d"] = 1.5;
  const _l: Precise["l"] = 5;
  const _dec: Precise["dec"] = new Decimal128("9.99");
  const _meta: Precise["meta"] = { anything: true };
  void _d;
  void _l;
  void _dec;
  void _meta;
  // @ts-expect-error — decimal fields infer as Decimal128, not number
  const _decBad: Precise["dec"] = 9.99;
  void _decBad;
};

void _precise;

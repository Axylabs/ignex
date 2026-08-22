/**
 * Canonical complex enterprise data model for the test suites and benchmarks.
 *
 * Exercises every dimension of the schema DSL a production system needs:
 * nested objects (3+ levels), arrays of objects, string + numeric enums,
 * defaults, string/number validators, `additionalProperties` control, objectId
 * references, and unique + secondary indexes. The same model feeds the schema
 * round-trip suite, the multistage aggregation suite, and the perf harness, so
 * the seed logic lives here as a single source of truth.
 *
 * NOTE: `s.string({ format })` is intentionally NOT used — MongoDB's
 * `$jsonSchema` rejects the `format` keyword, and the ORM no longer emits it.
 */
import type { Db, Document, InsertManyResult, InsertOneResult, ObjectId } from "mongodb";
import { defineCollection, defineCollections, type InferDoc, s } from "../../src/schema/index.ts";

/* ----------------------------- customers ----------------------------- */

export const customerSchema = s.object(
  {
    _id: s.objectId(),
    email: s.string(),
    profile: s.object({
      name: s.string({ minLength: 2, maxLength: 80 }),
      address: s.object(
        {
          street: s.string(),
          city: s.string(),
          country: s.string(),
          geo: s.object({ lat: s.number(), lng: s.number() }),
        },
        { additionalProperties: false },
      ),
    }),
    tier: s.enum(["bronze", "silver", "gold", "platinum"] as const),
    priority: s.enum([1, 2, 3] as const),
    tags: s.array(s.string()),
    prefs: s.object({
      newsletter: s.boolean().default(true),
      locale: s.string().default("en-US"),
    }),
    createdAt: s.date(),
  },
  { name: "customers" },
);
export type Customer = InferDoc<typeof customerSchema>;

/* ----------------------------- products ------------------------------ */

export const productSchema = s.object({
  _id: s.objectId(),
  sku: s.string({ pattern: "^[A-Z]{2}\\d{4}$" }),
  name: s.string(),
  category: s.enum(["electronics", "apparel", "home", "books"] as const),
  price: s.number({ minimum: 0 }),
  stock: s.integer({ minimum: 0 }),
  attributes: s
    .object({
      color: s.string().optional(),
      size: s.string().optional(),
      weightKg: s.number().optional(),
    })
    .optional(),
  tags: s.array(s.enum(["new", "sale", "featured", "clearance"] as const)),
});
export type Product = InferDoc<typeof productSchema>;

export const products = defineCollection("products", productSchema, {
  indexes: [{ key: { sku: 1 }, options: { unique: true } }],
});

/* ------------------------------ orders ------------------------------- */

export const orderSchema = s.object({
  _id: s.objectId(),
  customerId: s.objectId(),
  status: s.enum(["pending", "paid", "shipped", "cancelled"] as const),
  items: s.array(
    s.object({
      sku: s.string(),
      name: s.string(),
      qty: s.integer({ minimum: 1 }),
      unitPrice: s.number({ minimum: 0 }),
      discountPct: s.number({ minimum: 0, maximum: 100 }).optional(),
    }),
  ),
  totals: s.object({
    subtotal: s.number({ minimum: 0 }),
    tax: s.number({ minimum: 0 }),
    shipping: s.number({ minimum: 0 }),
    grandTotal: s.number({ minimum: 0 }),
    currency: s.string().default("USD"),
  }),
  billing: s.object({
    address: s.object({
      street: s.string(),
      city: s.string(),
      country: s.string(),
    }),
  }),
  couponCode: s.string({ minLength: 3, maxLength: 20 }).optional(),
  placedAt: s.date(),
  fulfilledAt: s.date().optional(),
});
export type Order = InferDoc<typeof orderSchema>;

export const orders = defineCollection("orders", orderSchema, {
  indexes: [
    { key: { customerId: 1 } },
    { key: { placedAt: -1 } },
    { key: { status: 1, placedAt: -1 } },
  ],
});

/* ------------------------------ reviews ------------------------------ */

export const reviewSchema = s.object({
  _id: s.objectId(),
  productId: s.objectId(),
  customerId: s.objectId(),
  rating: s.integer({ minimum: 1, maximum: 5 }),
  title: s.string({ minLength: 1, maxLength: 60 }),
  body: s.string({ minLength: 4, maxLength: 500 }),
  verified: s.boolean(),
  helpful: s.integer().default(0),
  createdAt: s.date(),
});
export type Review = InferDoc<typeof reviewSchema>;

export const reviews = defineCollection("reviews", reviewSchema, {
  indexes: [{ key: { productId: 1 } }, { key: { customerId: 1 } }],
});

/* ----------------------------- shipments ----------------------------- */

export const shipmentSchema = s.object({
  _id: s.objectId(),
  orderId: s.objectId(),
  carrier: s.enum(["fedex", "ups", "usps", "dhl"] as const),
  trackingNumber: s.string({ pattern: "^[A-Z0-9]{4,20}$" }),
  events: s.array(
    s.object({
      status: s.enum([
        "created",
        "picked_up",
        "in_transit",
        "out_for_delivery",
        "delivered",
      ] as const),
      at: s.date(),
    }),
  ),
  deliveredAt: s.date().optional(),
});
export type Shipment = InferDoc<typeof shipmentSchema>;

export const shipments = defineCollection("shipments", shipmentSchema, {
  indexes: [{ key: { orderId: 1 } }],
});

/* ----------------------------- registry ------------------------------ */

export const enterpriseCollections = defineCollections(
  customerSchema,
  products,
  orders,
  reviews,
  shipments,
);

export const enterpriseCollectionNames = [
  "customers",
  "products",
  "orders",
  "reviews",
  "shipments",
] as const;

/* ------------------------------- seed -------------------------------- */

/** Minimal structural view of the manager the seed needs (cast at call sites). */
export interface EnterpriseDb {
  client: Db;
  createSchema: (collection: string) => Promise<unknown>;
  insertOne: (collection: string, doc: Document) => Promise<InsertOneResult>;
  insertMany: (collection: string, docs: Document[]) => Promise<InsertManyResult>;
}

export interface EnterpriseScale {
  customers: number;
  products: number;
  /** Orders generated per customer. */
  ordersPerCustomer: number;
  /** Total reviews generated. */
  reviews: number;
}

export const defaultScale: EnterpriseScale = {
  customers: 6,
  products: 10,
  ordersPerCustomer: 5,
  reviews: 18,
};

export interface EnterpriseSeed {
  customerIds: ObjectId[];
  productIds: ObjectId[];
  productSkus: string[];
  orderIds: ObjectId[];
  reviewIds: ObjectId[];
  shipmentIds: ObjectId[];
}

const CITIES = ["Springfield", "Rivertown", "Lakewood", "Hillcrest", "Maplewood"];
const COUNTRIES = ["US", "CA", "GB"];
const TIERS = ["bronze", "silver", "gold", "platinum"] as const;
const CATEGORIES = ["electronics", "apparel", "home", "books"] as const;
const ORDER_STATUSES = ["pending", "paid", "shipped", "cancelled"] as const;
const CARRIERS = ["fedex", "ups", "usps", "dhl"] as const;
const PRODUCT_TAGS = ["new", "sale", "featured", "clearance"] as const;
const SHIPMENT_EVENTS = [
  "created",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
] as const;

const DAY = 86_400_000;

/**
 * Drop + recreate every enterprise collection with its `$jsonSchema` validator
 * (and declared indexes), then insert a deterministic dataset.
 *
 * Deterministic by construction (pure index loops — no RNG), so assertions on
 * specific customers/orders/aggregates are stable across runs.
 */
export const seedEnterprise = async (
  db: EnterpriseDb,
  scale: Partial<EnterpriseScale> = {},
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fixture seeder is inherently branchy
): Promise<EnterpriseSeed> => {
  const cfg: EnterpriseScale = { ...defaultScale, ...scale };

  for (const name of enterpriseCollectionNames) {
    await db.client.dropCollection(name).catch(() => {});
    await db.createSchema(name);
  }

  const seed: EnterpriseSeed = {
    customerIds: [],
    productIds: [],
    productSkus: [],
    orderIds: [],
    reviewIds: [],
    shipmentIds: [],
  };

  const base = new Date("2026-01-01T00:00:00.000Z").getTime();

  // customers
  const customerDocs: Document[] = [];
  for (let i = 0; i < cfg.customers; i++) {
    const tier = TIERS[i % TIERS.length]!;
    customerDocs.push({
      email: `cust${i}@example.com`,
      profile: {
        name: `Customer ${i}`,
        address: {
          street: `${100 + i} Main St`,
          city: CITIES[i % CITIES.length]!,
          country: COUNTRIES[i % COUNTRIES.length]!,
          geo: { lat: 10 + i * 0.5, lng: -20 - i * 0.25 },
        },
      },
      tier,
      priority: (i % 3) + 1,
      tags: tier === "gold" || tier === "platinum" ? ["vip"] : [],
      prefs: { newsletter: i % 3 !== 0, locale: i % 2 === 0 ? "en-US" : "fr-FR" },
      createdAt: new Date(base + i * DAY),
    });
  }
  const custRes = await db.insertMany("customers", customerDocs);
  for (const id of Object.values(custRes.insertedIds)) seed.customerIds.push(id);

  // products
  const productDocs: Document[] = [];
  for (let i = 0; i < cfg.products; i++) {
    const hasAttrs = i % 3 !== 0; // some products omit the optional nested object
    productDocs.push({
      sku: `AB${String(i).padStart(4, "0")}`,
      name: `Product ${i}`,
      category: CATEGORIES[i % CATEGORIES.length],
      price: Math.round((i * 10 + 4.99) * 100) / 100,
      stock: Math.max(1, 100 - i * 7), // stays >= 1 (schema minimum 0) at any scale
      ...(hasAttrs
        ? {
            attributes: {
              color: ["red", "blue", "black"][i % 3],
              size: ["S", "M", "L"][i % 3],
              weightKg: 0.5 + i * 0.1,
            },
          }
        : {}),
      tags: [PRODUCT_TAGS[i % PRODUCT_TAGS.length]],
    });
  }
  const prodRes = await db.insertMany("products", productDocs);
  for (const id of Object.values(prodRes.insertedIds)) {
    seed.productIds.push(id);
    seed.productSkus.push(`AB${String(seed.productSkus.length).padStart(4, "0")}`);
  }

  // orders + shipments
  let orderIndex = 0;
  for (let c = 0; c < cfg.customers; c++) {
    const customerId = seed.customerIds[c]!;
    for (let o = 0; o < cfg.ordersPerCustomer; o++) {
      const status = ORDER_STATUSES[orderIndex % ORDER_STATUSES.length];
      const itemCount = (orderIndex % 3) + 1; // 1..3 items
      const items: Document[] = [];
      let subtotal = 0;
      for (let k = 0; k < itemCount; k++) {
        const skuIdx = (orderIndex + k) % cfg.products;
        const qty = (k % 2) + 1;
        const unitPrice = seedProductPrice(skuIdx);
        const discountPct = k === 1 ? 10 : undefined;
        subtotal += qty * unitPrice;
        items.push({
          sku: seed.productSkus[skuIdx],
          name: `Product ${skuIdx}`,
          qty,
          unitPrice,
          ...(discountPct !== undefined ? { discountPct } : {}),
        });
      }
      const tax = Math.round(subtotal * 0.1 * 100) / 100;
      const shipping = status === "cancelled" ? 0 : 5;
      const grandTotal = Math.round((subtotal + tax + shipping) * 100) / 100;
      const placedAt = new Date(base + orderIndex * 2 * DAY);
      const doc: Document = {
        customerId,
        status,
        items,
        totals: {
          subtotal: Math.round(subtotal * 100) / 100,
          tax,
          shipping,
          grandTotal,
          currency: "USD",
        },
        billing: {
          address: {
            street: `${100 + c} Main St`,
            city: CITIES[c % CITIES.length],
            country: COUNTRIES[c % COUNTRIES.length],
          },
        },
        ...(orderIndex % 4 === 0 ? { couponCode: "SAVE10" } : {}),
        placedAt,
        ...(status === "shipped" ? { fulfilledAt: new Date(placedAt.getTime() + 2 * DAY) } : {}),
      };
      const res = await db.insertOne("orders", doc);
      seed.orderIds.push(res.insertedId);

      if (status === "paid" || status === "shipped") {
        const carrier = CARRIERS[orderIndex % CARRIERS.length];
        const events: Document[] = [{ status: "created", at: placedAt }];
        if (status === "shipped") {
          events.push(
            { status: "picked_up", at: new Date(placedAt.getTime() + DAY) },
            { status: "in_transit", at: new Date(placedAt.getTime() + DAY * 1.5) },
          );
        }
        const shipmentRes = await db.insertOne("shipments", {
          orderId: res.insertedId,
          carrier,
          trackingNumber: `TRK${String(orderIndex).padStart(3, "0")}A`,
          events,
          ...(status === "shipped" ? { deliveredAt: new Date(placedAt.getTime() + 3 * DAY) } : {}),
        });
        seed.shipmentIds.push(shipmentRes.insertedId);
      }
      orderIndex++;
    }
  }

  // reviews
  const reviewDocs: Document[] = [];
  for (let i = 0; i < cfg.reviews; i++) {
    reviewDocs.push({
      productId: seed.productIds[i % cfg.products],
      customerId: seed.customerIds[i % cfg.customers],
      rating: (i % 5) + 1,
      title: `Review ${i}`,
      body: `Solid ${CATEGORIES[i % CATEGORIES.length]} item number ${i}.`,
      verified: i % 2 === 0,
      createdAt: new Date(base + i * 3 * DAY),
    });
  }
  const reviewRes = await db.insertMany("reviews", reviewDocs);
  for (const id of Object.values(reviewRes.insertedIds)) seed.reviewIds.push(id);

  return seed;
};

const seedProductPrice = (skuIdx: number): number => Math.round((skuIdx * 10 + 4.99) * 100) / 100;

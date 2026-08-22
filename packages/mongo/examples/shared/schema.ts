/**
 * Canonical schema registry for the examples.
 *
 * Collection names live on the schemas themselves (`s.object({...}, { name })`
 * or `defineCollection(name, schema, extras)`); `defineCollections` derives the
 * `collections` map keyed by those names. Every example shares this registry,
 * so collection names and document types are type-checked everywhere.
 */
import { defineCollection, defineCollections, type InferDoc, s } from "../../src/index.ts";

export const userSchema = s.object(
  {
    _id: s.objectId(),
    email: s.string(),
    name: s.string().optional(),
    role: s.enum(["admin", "user"] as const),
    createdAt: s.date(),
  },
  { name: "users" },
);
export type User = InferDoc<typeof userSchema>;

export const orderSchema = s.object(
  {
    _id: s.objectId(),
    userId: s.objectId(),
    total: s.number({ minimum: 0 }),
    status: s.enum(["pending", "paid", "shipped"] as const),
    createdAt: s.date(),
  },
  { name: "orders" },
);
export type Order = InferDoc<typeof orderSchema>;

export const productSchema = s.object({
  _id: s.objectId(),
  sku: s.string(),
  name: s.string(),
  price: s.number({ minimum: 0 }),
});
export type Product = InferDoc<typeof productSchema>;

/** `defineCollection` convenience: name + schema + optional indexes/hooks. */
export const products = defineCollection("products", productSchema, {
  indexes: [{ key: { sku: 1 }, options: { unique: true } }],
});

export const tagSchema = s.object({ _id: s.objectId(), label: s.string() }, { name: "tags" });
export type Tag = InferDoc<typeof tagSchema>;

/** Join collection for the manyToMany products↔tags relation. */
export const productTagSchema = s.object(
  { _id: s.objectId(), productId: s.objectId(), tagId: s.objectId() },
  { name: "product_tags" },
);
export type ProductTag = InferDoc<typeof productTagSchema>;

/**
 * The derived `collections` map — its keys ARE the schema names. A typo'd
 * collection name is a type error at every call site (CRUD, query builder,
 * populate, pagination, aggregation).
 */
export const collections = defineCollections(
  userSchema,
  orderSchema,
  products,
  tagSchema,
  productTagSchema,
);

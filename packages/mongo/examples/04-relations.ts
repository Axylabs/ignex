/**
 * DataLoader-batched relations — fully type-checked at the `populate` call
 * site: `collection`, `localField`, `foreignField` and `through` are validated
 * against the schema registry, and the joined `as` fields are typed.
 *
 *   bun run examples/04-relations.ts
 */
import { belongsTo, hasMany, manyToMany } from "../src/index.ts";
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_04_relations";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  // Seed users, orders, products, tags and the join docs.
  const { insertedId: userId } = await db.insertOne("users", {
    email: "ada@example.com",
    role: "admin",
    createdAt: new Date(),
  });
  await db.insertMany("orders", [
    { userId, total: 199.99, status: "paid", createdAt: new Date() },
    { userId, total: 59.5, status: "pending", createdAt: new Date() },
  ]);
  const { insertedId: productId } = await db.insertOne("products", {
    sku: "A-1",
    name: "Widget",
    price: 9.99,
  });
  const { insertedId: tagId } = await db.insertOne("tags", { label: "featured" });
  await db.insertOne("product_tags", { productId, tagId });

  // belongsTo + hasMany: `customer` is `User | null`, `more` is `Order[]`.
  const orders = await db.findMany("orders", {});
  const populated = await db.populate(orders, [
    belongsTo({ collection: "users", localField: "userId", as: "customer" }),
    hasMany({ collection: "orders", localField: "_id", as: "more" }),
  ]);
  console.log("first order customer:", populated[0]?.customer?.email);
  console.log('its "more" orders:', populated[0]?.more?.length);

  // manyToMany through the join collection: `tags` is `Tag[]`.
  const products = await db.findMany("products", {});
  const tagged = await db.populate(products, [
    manyToMany({
      collection: "tags",
      localField: "_id",
      as: "tags",
      through: { collection: "product_tags", localField: "productId", foreignField: "tagId" },
    }),
  ]);
  console.log(
    "product tags:",
    tagged[0]?.tags?.map((t) => t.label),
  );

  // A typo here is a compile error:
  //   belongsTo({ collection: 'users', localField: 'nope', as: 'x' })
  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

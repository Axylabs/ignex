/**
 * Hooks — per-collection lifecycle middleware.
 *
 *   bun run examples/16-hooks.ts
 *
 * Demonstrates `defineCollection(..., { hooks })`: before/after create, update,
 * delete, and `afterRead`. Hooks run around the corresponding CRUD op (create
 * hooks also fire for `insertMany`).
 */
import { createMongoToolkit, defineCollection, defineCollections, s } from "../src/index.ts";
import { MONGO_URL } from "./shared/setup.ts";

const DB = "ninox_examples_16_hooks";

const run = async () => {
  const events: string[] = [];

  const userSchema = s.object(
    { _id: s.objectId(), email: s.string(), role: s.enum(["admin", "user"] as const) },
    { name: "users" },
  );
  const users = defineCollection("users", userSchema, {
    hooks: {
      beforeCreate: (ctx) => {
        events.push(`beforeCreate:${ctx.doc?.email}`);
      },
      afterCreate: (ctx) => {
        events.push(`afterCreate:${ctx.doc?.email}`);
      },
      beforeUpdate: (ctx) => {
        events.push(`beforeUpdate:${String(ctx.filter)}`);
      },
      afterUpdate: () => {
        events.push("afterUpdate");
      },
      beforeDelete: () => {
        events.push("beforeDelete");
      },
      afterDelete: () => {
        events.push("afterDelete");
      },
      afterRead: (ctx) => {
        events.push(`afterRead:${ctx.doc?._id ?? "many"}`);
      },
    },
  });

  const toolkit = createMongoToolkit(
    { primary: { name: DB, dbUrl: MONGO_URL, collections: defineCollections(users) } },
    { logger: { debug() {}, info() {}, warn() {}, error() {} } },
  );
  await toolkit.service.makeConnections();
  const db = toolkit.service.db.primaryClient;
  await db.client.dropCollection("users").catch(() => {});
  await db.createSchema("users");

  const { insertedId } = await db.insertOne("users", {
    email: "hook@example.com",
    role: "admin",
  });
  await db.getOne("users", { _id: insertedId });
  await db.updateOne("users", { _id: insertedId }, { $set: { role: "user" } });
  await db.deleteOne("users", { _id: insertedId });

  console.log("hook events (in order):");
  for (const event of events) console.log(`  - ${event}`);

  await toolkit.service.closeConnections();
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

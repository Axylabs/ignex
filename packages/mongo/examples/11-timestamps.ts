/**
 * Auto timestamps — the `timestamps` collection option stamps `createdAt` /
 * `updatedAt` on insert and `updatedAt` on every update (default field names,
 * or custom via an options object). Declare the fields in the schema (optional
 * is fine) and the ORM fills them.
 *
 *   bun run examples/11-timestamps.ts
 */
import { createMongoToolkit, defineCollection, defineCollections, s } from "../src/index.ts";

const DB = "ninox_examples_11_timestamps";
const MONGO_URL = process.env.MONGO_URL ?? "mongodb://admin:admin@localhost:27017/";

const noteSchema = s.object({
  _id: s.objectId(),
  title: s.string(),
  body: s.string().optional(),
  createdAt: s.date().optional(),
  updatedAt: s.date().optional(),
});
const notes = defineCollection("notes", noteSchema, { timestamps: true });

const run = async () => {
  const toolkit = createMongoToolkit(
    {
      primary: { name: DB, dbUrl: MONGO_URL, collections: defineCollections(notes) },
    },
    { logger: { debug() {}, info() {}, warn() {}, error() {} } },
  );
  const { service } = toolkit;
  await service.makeConnections();
  const db = service.db.primaryClient;
  await db.client.dropCollection("notes").catch(() => {});
  await db.createSchema("notes");

  const { insertedId } = await db.insertOne("notes", { title: "First" });
  const created = await db.getOne("notes", { _id: insertedId });
  console.log(
    "created :",
    created?.createdAt?.toISOString(),
    "| updated:",
    created?.updatedAt?.toISOString(),
  );

  await new Promise((r) => setTimeout(r, 5));
  await db.updateOne("notes", { _id: insertedId }, { $set: { title: "Second" } });
  const updated = await db.getOne("notes", { _id: insertedId });
  console.log(
    "updated :",
    updated?.updatedAt?.toISOString(),
    "(createdAt unchanged:",
    updated?.createdAt?.toISOString(),
    ")",
  );

  // upsert also stamps updatedAt
  await db.upsert("notes", { title: "Third" }, { $set: { body: "upserted" } });
  const upserted = await db.getOne("notes", { title: "Third" });
  console.log("upsert  : updatedAt =", upserted?.updatedAt?.toISOString());

  await service.closeConnections();
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

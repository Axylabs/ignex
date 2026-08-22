import { afterAll, beforeAll, expect, test } from "bun:test";
import { defineCollection, defineCollections, s } from "../src/schema/index.ts";
import { createMongoService } from "../src/service/index.ts";
import { MONGO_URL, maybeDescribe, noopLogger, probe } from "./helpers.ts";

const available = await probe();
const maybe = maybeDescribe(available);

const noteSchema = s.object({
  _id: s.objectId(),
  title: s.string(),
  body: s.string().optional(),
  createdAt: s.date().optional(),
  updatedAt: s.date().optional(),
});
const notes = defineCollection("notes", noteSchema, { timestamps: true });

const customNoteSchema = s.object({
  _id: s.objectId(),
  title: s.string(),
  madeAt: s.date().optional(),
  touchedAt: s.date().optional(),
});
const customNotes = defineCollection("customNotes", customNoteSchema, {
  timestamps: { createdAt: "madeAt", updatedAt: "touchedAt" },
});

const plainNoteSchema = s.object({ _id: s.objectId(), title: s.string() });
const plainNotes = defineCollection("plainNotes", plainNoteSchema);

maybe("auto timestamps (real MongoDB)", () => {
  const service = createMongoService(
    {
      primary: {
        name: "ninox_timestamps_test",
        dbUrl: MONGO_URL,
        collections: defineCollections(notes, customNotes, plainNotes),
      },
    },
    { logger: noopLogger },
  );
  let db!: typeof service.db.primaryClient;

  beforeAll(async () => {
    await service.makeConnections();
    db = service.db.primaryClient;
    await db.client.dropCollection("notes").catch(() => {});
    await db.client.dropCollection("customNotes").catch(() => {});
    await db.client.dropCollection("plainNotes").catch(() => {});
    await db.createSchema("notes");
    await db.createSchema("customNotes");
    await db.createSchema("plainNotes");
  });
  afterAll(() => service.closeConnections());

  test("insertOne stamps createdAt + updatedAt", async () => {
    const { insertedId } = await db.insertOne("notes", { title: "Hello" });
    const doc = await db.getOne("notes", { _id: insertedId });
    expect(doc?.createdAt).toBeInstanceOf(Date);
    expect(doc?.updatedAt).toBeInstanceOf(Date);
  });

  test("updateOne bumps updatedAt but leaves createdAt intact", async () => {
    const { insertedId } = await db.insertOne("notes", { title: "Before" });
    const before = await db.getOne("notes", { _id: insertedId });
    const created = before!.createdAt!.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await db.updateOne("notes", { _id: insertedId }, { $set: { title: "After" } });
    const after = await db.getOne("notes", { _id: insertedId });
    expect(after?.title).toBe("After");
    expect(after!.createdAt!.getTime()).toBe(created);
    expect(after!.updatedAt!.getTime()).toBeGreaterThan(created);
  });

  test("insertMany stamps every doc", async () => {
    const res = await db.insertMany("notes", [{ title: "a" }, { title: "b" }]);
    for (const id of Object.values(res.insertedIds)) {
      const doc = await db.getOne("notes", { _id: id });
      expect(doc?.createdAt).toBeInstanceOf(Date);
      expect(doc?.updatedAt).toBeInstanceOf(Date);
    }
  });

  test("custom field names are used", async () => {
    const { insertedId } = await db.insertOne("customNotes", { title: "Custom" });
    const doc = await db.getOne("customNotes", { _id: insertedId });
    expect(doc?.madeAt).toBeInstanceOf(Date);
    expect(doc?.touchedAt).toBeInstanceOf(Date);
    await db.updateOne("customNotes", { _id: insertedId }, { $set: { title: "x" } });
    const after = await db.getOne("customNotes", { _id: insertedId });
    expect(after!.touchedAt!.getTime()).toBeGreaterThanOrEqual(doc!.madeAt!.getTime());
  });

  test("upsert stamps updatedAt", async () => {
    await db.upsert("notes", { title: "Upserted" }, { $set: { body: "x" } });
    const doc = await db.getOne("notes", { title: "Upserted" });
    expect(doc?.updatedAt).toBeInstanceOf(Date);
  });

  test("collections without timestamps are untouched", async () => {
    const { insertedId } = await db.insertOne("plainNotes", { title: "Plain" });
    const doc = (await db.getOne("plainNotes", { _id: insertedId })) as {
      createdAt?: Date;
      updatedAt?: Date;
    };
    expect(doc.createdAt).toBeUndefined();
    expect(doc.updatedAt).toBeUndefined();
  });
});

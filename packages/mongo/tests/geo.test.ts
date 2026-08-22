import { afterAll, beforeAll, expect, test } from "bun:test";
import { defineCollection, defineCollections, s } from "../src/schema/index.ts";
import { createMongoService } from "../src/service/index.ts";
import { MONGO_URL, maybeDescribe, noopLogger, probe } from "./helpers.ts";

const available = await probe();
const maybe = maybeDescribe(available);

const placeSchema = s.object({
  _id: s.objectId(),
  name: s.string(),
  location: s.geoPoint(),
});
const places = defineCollection("places", placeSchema, {
  indexes: [{ key: { location: "2dsphere" } }],
});

maybe("geo (real MongoDB)", () => {
  const service = createMongoService(
    {
      primary: {
        name: "ninox_geo_test",
        dbUrl: MONGO_URL,
        collections: defineCollections(places),
      },
    },
    { logger: noopLogger },
  );
  let db!: typeof service.db.primaryClient;

  beforeAll(async () => {
    await service.makeConnections();
    db = service.db.primaryClient;
    await db.client.dropCollection("places").catch(() => {});
    await db.createSchema("places");
    await db.insertMany("places", [
      { name: "NYC", location: { type: "Point", coordinates: [-74.006, 40.7128] } },
      { name: "LA", location: { type: "Point", coordinates: [-118.2437, 34.0522] } },
      { name: "SF", location: { type: "Point", coordinates: [-122.4194, 37.7749] } },
    ]);
  });
  afterAll(() => service.closeConnections());

  test("s.geoPoint validates GeoJSON shape server-side", async () => {
    const bad = {
      name: "Bad",
      location: { type: "Point", coordinates: [-74, 40, 999] },
    } as never;
    await expect(db.insertOne("places", bad)).rejects.toThrow();
  });

  test("$geoNear pipeline stage returns sorted-by-distance docs with a distanceField", async () => {
    const results = await db
      .pipeline("places")
      .geoNear({
        near: { type: "Point", coordinates: [-74.006, 40.7128] },
        distanceField: "dist",
        spherical: true,
      })
      .limit(3)
      .toArray();
    expect(results.length).toBe(3);
    const first = results[0] as { name: string; dist: number };
    const second = results[1] as { name: string; dist: number };
    expect(first.name).toBe("NYC");
    expect(typeof first.dist).toBe("number");
    expect(first.dist).toBe(0);
    // Sanity: SF is ~4,100 km from NYC — spherical distance must be in meters.
    expect(second.dist).toBeGreaterThan(1_000_000);
    expect(first.dist).toBeLessThan(second.dist);
  });

  test("chained builder throws when $geoNear is not the first stage", () => {
    expect(() =>
      db
        .pipeline("places")
        .match({})
        .geoNear({ near: [-74, 40], distanceField: "d" }),
    ).toThrow(/first pipeline stage/);
  });

  test("callback aggregate supports $geoNear and enforces first-stage", async () => {
    const rows = await db.aggregate("places", (stages) => [
      stages.geoNear({
        near: { type: "Point", coordinates: [-74.006, 40.7128] },
        distanceField: "dist",
        spherical: true,
      }),
      stages.limit(2),
    ]);
    const arr = await rows.toArray();
    expect(arr.length).toBe(2);
    expect((arr[0] as { name: string }).name).toBe("NYC");

    await expect(
      db.aggregate("places", (stages) => [
        stages.match({}),
        stages.geoNear({ near: [-74, 40], distanceField: "d" }),
      ]),
    ).rejects.toThrow(/first pipeline stage/);
  });
});

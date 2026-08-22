/**
 * Geospatial — `s.geoPoint()` schema field + `$geoNear` aggregation stage.
 *
 * `$geoNear` requires a `2dsphere` (or `2d`) index on the location field and
 * MUST be the first pipeline stage. It adds the computed distance (meters when
 * `spherical: true`) to the `distanceField` of every output doc.
 *
 *   bun run examples/13-geo.ts
 */
import { createMongoToolkit, defineCollection, defineCollections, s } from "../src/index.ts";

const DB = "ninox_examples_13_geo";
const MONGO_URL = process.env.MONGO_URL ?? "mongodb://admin:admin@localhost:27017/";

const placeSchema = s.object({
  _id: s.objectId(),
  name: s.string(),
  location: s.geoPoint(),
});
const places = defineCollection("places", placeSchema, {
  indexes: [{ key: { location: "2dsphere" } }],
});

const run = async () => {
  const toolkit = createMongoToolkit(
    {
      primary: { name: DB, dbUrl: MONGO_URL, collections: defineCollections(places) },
    },
    { logger: { debug() {}, info() {}, warn() {}, error() {} } },
  );
  const { service } = toolkit;
  await service.makeConnections();
  const db = service.db.primaryClient;
  await db.client.dropCollection("places").catch(() => {});
  await db.createSchema("places");

  await db.insertMany("places", [
    { name: "NYC", location: { type: "Point", coordinates: [-74.006, 40.7128] } },
    { name: "LA", location: { type: "Point", coordinates: [-118.2437, 34.0522] } },
    { name: "SF", location: { type: "Point", coordinates: [-122.4194, 37.7749] } },
  ]);

  // Nearest to NYC, with a computed distance field.
  const nearest = await db
    .pipeline("places")
    .geoNear({
      near: { type: "Point", coordinates: [-74.006, 40.7128] },
      distanceField: "dist",
      spherical: true,
    })
    .limit(3)
    .toArray();
  for (const place of nearest as Array<{ name: string; dist: number }>) {
    console.log(`${place.name.padEnd(3)}  ${Math.round(place.dist).toLocaleString()} m`);
  }

  await service.closeConnections();
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

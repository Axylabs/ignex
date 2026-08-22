/**
 * Health + change streams — `service.health()`, `eachDb`, `watchCollection`.
 *
 *   bun run examples/18-health-watch.ts
 *
 * `health()` pings every connected DB (timeout-guarded). `watchCollection`
 * opens a caller-owned change stream — attach an `error` listener and `.close()`
 * when done.
 */

import { ObjectId } from "mongodb";
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_18_health_watch";

const run = async () => {
  const ctx = await connect(DB);
  const { toolkit, db } = ctx;

  // service.health() — one ping per connected DB.
  const health = await toolkit.service.health();
  console.log(
    `health: ok=${health.ok} latencyMs=${health.latencyMs.toFixed(1)} dbs=${health.dbs
      .map((d) => `${d.name}:${d.ok ? "up" : "down"}`)
      .join(", ")}`,
  );

  // eachDb — iterate every manager.
  const labels = await toolkit.service.eachDb(async (_manager, dbKey) => dbKey);
  console.log("eachDb keys:", labels);

  // watchCollection — caller-owned change stream. Attach an `error` listener
  // (change streams need a replica set; standalone servers error here).
  let changes = 0;
  let unsupported = false;
  const stream = db.watchCollection("orders");
  stream.on("error", (err) => {
    if (/only supported on replica sets/i.test(err.message)) unsupported = true;
    else console.error("stream error:", err.message);
  });
  stream.on("change", () => {
    changes++;
  });

  await db.insertOne("orders", {
    userId: new ObjectId(), // any ObjectId satisfies the schema
    total: 42,
    status: "pending",
    createdAt: new Date(),
  });

  // Change delivery is async — give the stream a moment, then close it.
  await new Promise((r) => setTimeout(r, 300));
  await stream.close();
  if (unsupported) {
    console.log(
      "watchCollection: change streams need a replica set (standalone server) — 0 events expected",
    );
  } else {
    console.log("watchCollection change events:", changes);
  }

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

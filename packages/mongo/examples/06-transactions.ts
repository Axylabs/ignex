/**
 * Transactions — graceful fallback on standalone servers.
 *
 * `db.transaction(fn(session))` runs inside a real session transaction when the
 * server supports it (replica set), and transparently falls back to
 * non-transactional execution on standalone. `withGracefulMongoTransaction`
 * adds a capability probe + explicit fallback.
 *
 *   bun run examples/06-transactions.ts
 */
import { createMongoCapabilitiesStore, withGracefulMongoTransaction } from "../src/index.ts";
import { close, connect, MONGO_URL } from "./shared/setup.ts";

const DB = "ninox_examples_06_transactions";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  const { insertedId: userId } = await db.insertOne("users", {
    email: "buyer@example.com",
    role: "user",
    createdAt: new Date(),
  });

  // Service-level transaction (falls back to non-transactional on standalone).
  await db.transaction(async (session) => {
    await db.insertOne(
      "orders",
      { userId, total: 9.99, status: "pending", createdAt: new Date() },
      { session: session ?? undefined },
    );
    await db.insertOne(
      "orders",
      { userId, total: 4.5, status: "pending", createdAt: new Date() },
      { session: session ?? undefined },
    );
  });
  console.log("orders in transaction:", await db.countDocuments("orders", {}));

  // Explicit graceful wrapper with a capability probe + fallback.
  const caps = createMongoCapabilitiesStore();
  await withGracefulMongoTransaction(
    { transaction: db.transaction },
    async (session) => {
      await db.insertOne(
        "orders",
        { userId, total: 1.0, status: "pending", createdAt: new Date() },
        { session: session ?? undefined },
      );
    },
    { capabilities: caps, urlHint: MONGO_URL },
  );
  console.log("orders after graceful transaction:", await db.countDocuments("orders", {}));

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

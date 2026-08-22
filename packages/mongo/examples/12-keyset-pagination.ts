/**
 * Keyset (cursor) pagination — `paginateCursor` walks a `$or` tuple filter on
 * the last-seen row's sort values. O(log n) per page (no deep `$skip`), stable
 * under concurrent inserts. No total count (that's `paginateFlexible`'s job).
 *
 *   bun run examples/12-keyset-pagination.ts
 */
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_12_keyset";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  // Seed a user + 23 orders with distinct createdAt values.
  const userRes = await db.insertOne("users", {
    email: "cursor@example.com",
    role: "user",
    createdAt: new Date(),
  });
  const userId = userRes.insertedId;
  await db.insertMany(
    "orders",
    Array.from({ length: 23 }, (_, i) => ({
      userId,
      total: (i + 1) * 10,
      status: i % 2 === 0 ? "paid" : "pending",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    })),
  );

  // Sort must include a unique tiebreaker (`_id`).
  const sort = { createdAt: -1, _id: 1 } as Record<string, 1 | -1>;

  let cursor: string | undefined;
  let pageNum = 0;
  let hasMore = true;
  while (hasMore && pageNum < 20) {
    const page = await db.paginateCursor("orders", { userId }, { sort, limit: 5, after: cursor });
    console.log(
      `page ${++pageNum}: totals [${page.data.map((o) => o.total).join(", ")}] ${page.hasMore ? "(more)" : "(last)"}`,
    );
    hasMore = page.hasMore;
    cursor = page.nextCursor ?? undefined;
  }

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

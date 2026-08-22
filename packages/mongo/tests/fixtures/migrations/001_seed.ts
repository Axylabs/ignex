import type { MigrationContext } from "../../../src/migrations/index.ts";

/** Migration fixture used by the integration test's migration runner. */
export const up = async (ctx: MigrationContext): Promise<void> => {
  const users = (ctx.service as { db: Record<string, unknown> }).db.primaryClient as {
    insertOne(collection: string, doc: Record<string, unknown>): Promise<unknown>;
  };
  await users.insertOne("users", {
    email: "migrated@example.com",
    role: "user",
    createdAt: new Date(),
  });
};

export const down = async (ctx: MigrationContext): Promise<void> => {
  const users = (ctx.service as { db: Record<string, unknown> }).db.primaryClient as {
    deleteMany(collection: string, filter: Record<string, unknown>): Promise<unknown>;
  };
  await users.deleteMany("users", { email: "migrated@example.com" });
};

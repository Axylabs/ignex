import type { MigrationContext } from "../../../src/migrations/index.ts";

/** Seed one product via the migration runner. */
export const up = async (ctx: MigrationContext): Promise<void> => {
  const service = ctx.service as {
    db: {
      primaryClient: {
        insertOne(collection: string, doc: Record<string, unknown>): Promise<unknown>;
      };
    };
  };
  await service.db.primaryClient.insertOne("products", {
    sku: "MIGRATED",
    name: "Migrated product",
    price: 1,
  });
};

export const down = async (ctx: MigrationContext): Promise<void> => {
  const service = ctx.service as {
    db: {
      primaryClient: {
        deleteMany(collection: string, filter: Record<string, unknown>): Promise<unknown>;
      };
    };
  };
  await service.db.primaryClient.deleteMany("products", { sku: "MIGRATED" });
};

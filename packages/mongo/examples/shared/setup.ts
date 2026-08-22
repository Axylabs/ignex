/**
 * Shared setup/teardown for runnable examples.
 *
 * Each example connects to a uniquely-named database, drops + recreates every
 * collection with its `$jsonSchema` validator, and closes the pool when done.
 * Performance (query cache + in-flight dedup) is ON by default — no config
 * needed.
 */
import { createMongoToolkit, type LoggerLike } from "../../src/index.ts";
import { collections } from "./schema.ts";

export const MONGO_URL = process.env.MONGO_URL ?? "mongodb://admin:admin@localhost:27017/";

/** Optional service-config overrides (e.g. `cacheWatch` for example 20). */
export interface ConnectOptions {
  cacheWatch?: boolean;
  logger?: LoggerLike;
}

export const connect = async (dbName: string, options: ConnectOptions = {}) => {
  const toolkit = createMongoToolkit(
    {
      primary: { name: dbName, dbUrl: MONGO_URL, collections },
    },
    {
      // Silent by default so examples' own console.log output stays clean;
      // example 20 passes `createConsoleLogger()` to surface the cacheWatch warning.
      logger: options.logger ?? { debug() {}, info() {}, warn() {}, error() {} },
      ...(options.cacheWatch !== undefined ? { cacheWatch: options.cacheWatch } : {}),
    },
  );
  await toolkit.service.makeConnections();
  const db = toolkit.service.db.primaryClient;
  for (const logical of Object.keys(collections)) {
    await db.client.dropCollection(logical).catch(() => {});
    await db.createSchema(logical);
  }
  return { toolkit, db };
};

export type ExampleContext = Awaited<ReturnType<typeof connect>>;

/** Drain in-flight connection setup, then close the pool (matches the demo). */
export const close = async (ctx: ExampleContext): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await ctx.toolkit.service.closeConnections();
};

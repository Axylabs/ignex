/**
 * Service facade — the composition root. `createMongoService` wires the whole
 * ORM: it resolves config (`./config.ts`), opens pooled connections
 * (`./connection.ts`), assembles one `CollectionManager` per database
 * (`./manager.ts`), and exposes health (`./health.ts`).
 *
 * Kept deliberately thin: each concern lives in a sibling module and is only
 * composed here.
 */
import { type MongoClient, ObjectId } from "mongodb";
import { InFlight } from "../cache/in-flight.ts";
import type { DbClientsDefinition, ExtractDbNames } from "../types.ts";
import type { LoggerLike } from "../utils/logger.ts";
import type { CacheInvalidationRef } from "./cache-invalidation.ts";
import { CacheInvalidator } from "./cache-invalidation.ts";
import {
  type MongoServiceConfig,
  type ResolvedServiceConfig,
  resolveRuntimeConfig,
} from "./config.ts";
import {
  closeConnections as closePool,
  makeConnectionFactory,
  makeGetDbUrl,
} from "./connection.ts";
import { createHealth, type HealthReport } from "./health.ts";
import { buildManager, type CollectionManager } from "./manager.ts";

export type MongoService<TClients extends DbClientsDefinition = DbClientsDefinition> = {
  db: {
    [K in ExtractDbNames<TClients> as `${K}Client`]: CollectionManager<TClients, K>;
  };
  /** Open the pooled MongoClients and build all managers. */
  makeConnections: (names?: (keyof TClients & string)[]) => Promise<void>;
  closeConnections: () => Promise<void>;
  /** Run `fn` over every connected manager (in parallel). */
  eachDb: <T>(fn: (manager: unknown, dbKey: string) => Promise<T>) => Promise<T[]>;
  /** Ping every connected database and report per-DB health. */
  health: () => Promise<HealthReport>;
  getDbUrl: (name: string) => string;
  config: { defaultDb: string; migrationDir: string; appName: string };
  logger: LoggerLike;
  ObjectId: typeof ObjectId;
};

/**
 * Assemble the ORM service from a client definition:
 *
 *   const service = createMongoService({
 *     primary: {
 *       name: 'app',
 *       dbUrl: process.env.MONGO_URL,
 *       collectionPrefix: process.env.DB_PREFIX,
 *       collections: { users: userSchema, orders: { schema: orderSchema, indexes: [...] } },
 *     },
 *   });
 *   await service.makeConnections();
 *   const users = service.db.primaryClient;
 *   await users.insertOne('users', { email });
 *   const page = await users.paginateFlexible('users', {}, { page: 1, limit: 20 });
 */
export const createMongoService = <TClients extends DbClientsDefinition = DbClientsDefinition>(
  dbClients: TClients,
  configOverrides: MongoServiceConfig = {},
): MongoService<TClients> => {
  const runtime: ResolvedServiceConfig = resolveRuntimeConfig(configOverrides);
  const { config, logger, sharedCache, dedupeReads } = runtime;

  const db: Record<string, unknown> = {};
  const openedClients = new Map<string, MongoClient>();
  const inFlight = new InFlight();
  const getDbUrl = makeGetDbUrl(dbClients, config);
  // Optional change-stream invalidation of the shared cache (external writers).
  const collectionRefs: CacheInvalidationRef[] = [];
  const cacheInvalidator =
    sharedCache !== undefined && configOverrides.cacheWatch === true
      ? new CacheInvalidator({ cache: sharedCache, logger })
      : undefined;

  const baseMakeConnections = makeConnectionFactory(
    dbClients,
    db,
    getDbUrl,
    ((key: string, dbName: string, client: MongoClient) =>
      buildManager(
        {
          dbClients,
          config,
          logger,
          ...(sharedCache !== undefined ? { sharedCache } : {}),
          dedupeReads,
          inFlight,
          wrapMongoErrors: runtime.wrapMongoErrors,
          ...(configOverrides.drift !== undefined ? { drift: configOverrides.drift } : {}),
          collectionRefs,
          db,
        },
        key as ExtractDbNames<TClients>,
        dbName,
        client,
      )) as (dbKey: string, dbName: string, client: MongoClient) => unknown,
    openedClients,
  );
  // Open change-stream cache-invalidation watchers once connections are up, and
  // tear them down before the pool closes.
  const makeConnections = async (names?: (keyof TClients & string)[]): Promise<void> => {
    await baseMakeConnections(names);
    await cacheInvalidator?.start(collectionRefs);
  };
  const closeConnections = async (): Promise<void> => {
    await cacheInvalidator?.stop();
    collectionRefs.length = 0;
    await closePool(openedClients);
  };

  const eachDb = async <T>(fn: (manager: unknown, dbKey: string) => Promise<T>): Promise<T[]> => {
    return Promise.all(Object.keys(db).map((key) => fn(db[key], key.replace(/Client$/, ""))));
  };

  const health = createHealth(db);

  return {
    db: db as MongoService<TClients>["db"],
    makeConnections,
    closeConnections,
    eachDb,
    health,
    getDbUrl,
    config,
    logger,
    ObjectId,
  };
};

export type { CacheInvalidationRef } from "./cache-invalidation.ts";
export { CacheInvalidator } from "./cache-invalidation.ts";
export type { ResolvedServiceConfig } from "./config.ts";
// Re-export the public service surface so `service/index.ts` remains the single
// import site (matches the pre-refactor exports; the barrel re-exports these).
export { type MongoServiceConfig, resolveCache } from "./config.ts";
export { createHealth, type DbHealthResult, type HealthReport } from "./health.ts";
export { type BuildManagerDeps, buildManager, type CollectionManager } from "./manager.ts";

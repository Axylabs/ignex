/**
 * Shared test harness for the `ninox` test suites.
 *
 * Centralizes the connectivity probe, NOOP logger, server query counter, and
 * the enterprise-service bootstrap that the Mongo-backed suites (integration,
 * pipeline, schema-complex, aggregation, agg-perf) all need — previously
 * copy-pasted per file.
 */
import { describe } from "bun:test";
import { type Db, MongoClient } from "mongodb";
import { probeMongoCapabilities } from "../src/capabilities.ts";
import {
  createMongoService,
  type MongoService,
  type MongoServiceConfig,
} from "../src/service/index.ts";
import type { LoggerLike } from "../src/utils/logger.ts";
import {
  type EnterpriseDb,
  type EnterpriseScale,
  type EnterpriseSeed,
  enterpriseCollections,
  seedEnterprise,
} from "./fixtures/enterprise.ts";

export const MONGO_URL = process.env.MONGO_URL ?? "mongodb://admin:admin@localhost:27017/";

export const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

/** Probe for a reachable local MongoDB (mirrors the existing suite pattern). */
export const probe = async (): Promise<boolean> => {
  try {
    const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 1500 });
    await client.connect();
    await client.close();
    return true;
  } catch {
    return false;
  }
};

/** `describe` when Mongo is available, `describe.skip` otherwise. */
export const maybeDescribe = (available: boolean) => (available ? describe : describe.skip);

/**
 * Detect whether `MONGO_URL` points at a replica set (transactions + change
 * streams supported). Uses a throwaway connection so suites can gate on this
 * at module load time — `beforeAll` runs too late to switch `test.skip`.
 */
export const probeReplica = async (): Promise<boolean> => {
  if (!(await probe())) return false;
  try {
    const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 1500 });
    await client.connect();
    try {
      const caps = await probeMongoCapabilities(client);
      return caps.probed && caps.transactionsSupported;
    } finally {
      await client.close().catch(() => {});
    }
  } catch {
    return false;
  }
};

/** Current server query counter (`opcounters.query`). */
export const serverQueryCount = async (db: Db): Promise<number> => {
  const status = await db.admin().command({ serverStatus: 1 });
  return (status as { opcounters?: { query?: number } }).opcounters?.query ?? 0;
};

export interface EnterpriseServiceOptions {
  scale?: Partial<EnterpriseScale>;
  cache?: MongoServiceConfig["cache"];
  /** Opt into change-stream cache invalidation (replica sets). */
  cacheWatch?: boolean;
  dedupeReads?: boolean;
  perf?: boolean;
  wrapMongoErrors?: boolean;
  /** Schema-drift policy for reads (default 'report'). */
  drift?: MongoServiceConfig["drift"];
  /** Custom logger (default noop). */
  logger?: LoggerLike;
}

type EnterpriseClients = {
  primary: { name: string; dbUrl: string; collections: typeof enterpriseCollections };
};
export type EnterpriseService = MongoService<EnterpriseClients>;
export type EnterpriseManager = EnterpriseService["db"]["primaryClient"];

export interface EnterpriseServiceContext {
  service: EnterpriseService;
  db: EnterpriseManager;
  seed: EnterpriseSeed;
}

/**
 * Build a service + manager against the canonical enterprise model in a
 * uniquely-named DB: drops + recreates every collection (installing the
 * `$jsonSchema` validator and declared indexes), then inserts deterministic
 * seed data. Returns the context a test needs, including the manager's raw
 * `client` escape hatch (via `ctx.db.client`).
 */
export const makeEnterpriseService = async (
  dbName: string,
  options: EnterpriseServiceOptions = {},
): Promise<EnterpriseServiceContext> => {
  const service = createMongoService(
    {
      primary: { name: dbName, dbUrl: MONGO_URL, collections: enterpriseCollections },
    },
    {
      logger: options.logger ?? noopLogger,
      cache: options.cache,
      cacheWatch: options.cacheWatch,
      dedupeReads: options.dedupeReads,
      perf: options.perf,
      wrapMongoErrors: options.wrapMongoErrors,
      drift: options.drift,
    },
  ) as unknown as EnterpriseService;
  await service.makeConnections();
  const db = service.db.primaryClient;
  const seed = await seedEnterprise(db as unknown as EnterpriseDb, options.scale);
  return { service, db, seed };
};

/** Close a service's connection pool (safe in `afterAll`). */
export const closeService = async (
  ctx: Pick<EnterpriseServiceContext, "service">,
): Promise<void> => {
  await ctx.service.closeConnections();
};

/**
 * A logger that records every `warn` call, so tests can assert report-mode
 * drift logging (message + structured payload). Other levels are no-ops.
 */
export const captureLogger = (): {
  logger: LoggerLike;
  warns: Array<{ obj?: Record<string, unknown>; msg?: string }>;
} => {
  const warns: Array<{ obj?: Record<string, unknown>; msg?: string }> = [];
  const logger: LoggerLike = {
    debug() {},
    info() {},
    warn(a: unknown, b?: string) {
      const obj = typeof a === "string" ? undefined : (a as Record<string, unknown>);
      const msg = typeof a === "string" ? a : b;
      warns.push({ obj, msg });
    },
    error() {},
  };
  return { logger, warns };
};

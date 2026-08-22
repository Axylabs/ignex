/**
 * Per-database manager assembly. `buildManager` is the composition point of the
 * op-factory pattern: it builds the collection registry (schema/hooks/
 * timestamps), resolves logical→physical names, and **spreads** every
 * `make*Ops` factory into one `CollectionManager` object per database.
 *
 * The `CollectionManager` type mirrors that spread as an intersection so both
 * the runtime value and its type stay in sync from a single source.
 */
import type { Db, Document, MongoClient } from "mongodb";
import type { InFlight } from "../cache/in-flight.ts";
import type { QueryCache } from "../cache/query-cache.ts";
import { BadRequest } from "../errors/index.ts";
import type { HooksRegistry } from "../hooks/hooks.ts";
import { makePopulator, type PopulateOptions } from "../relation/populate.ts";
import type { JoinedFields, RelationDef, ValidRelation } from "../relation/relation.ts";
import type { DriftMode } from "../schema/validate-doc/index.ts";
import type { CollectionLike, DbClientsDefinition } from "../types.ts";
import { asCollectionDefinition, type ExtractDbNames } from "../types.ts";
import type { LoggerLike } from "../utils/logger.ts";
import { makeAggregationOps } from "./aggregation/index.ts";
import type { CacheInvalidationRef } from "./cache-invalidation.ts";
import { createResolveCollectionName } from "./collection-name.ts";
import type { CrudOps, TimestampsByCollection } from "./crud/index.ts";
import { makeCrudOps } from "./crud/index.ts";
import { makePaginationOps } from "./pagination/index.ts";
import { makeSchemaOps } from "./schema-ops.ts";
import { makeTransactionOps } from "./transaction.ts";

/** Everything `buildManager` needs from the composition root. */
export interface BuildManagerDeps<TClients extends DbClientsDefinition> {
  dbClients: TClients;
  config: { defaultDb: string; migrationDir: string; appName: string };
  logger: LoggerLike;
  sharedCache?: QueryCache;
  dedupeReads: boolean;
  inFlight: InFlight;
  wrapMongoErrors: boolean;
  drift?: DriftMode;
  /** Watch refs for cache-invalidation (physical names) — pushed to as managers build. */
  collectionRefs: CacheInvalidationRef[];
  /** The shared `db` record (sibling managers reference each other cross-DB). */
  db: Record<string, unknown>;
}

/** One collection manager per connected DB — the ORM's primary surface. */
export type CollectionManager<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
> = CrudOps<TClients, TDb> &
  ReturnType<typeof makePaginationOps<TClients, TDb>> &
  ReturnType<typeof makeAggregationOps<TClients, TDb>> &
  ReturnType<typeof makeSchemaOps> &
  ReturnType<typeof makeTransactionOps> & {
    /**
     * DataLoader-backed relation population (kills N+1). Each relation is
     * validated against the schema registry (`collection` / `localField` /
     * `foreignField` / `through`), and the joined `as` fields are typed.
     */
    populate: <const T extends Document, const R extends readonly RelationDef[]>(
      docs: T[],
      relations: R & { [K in keyof R]: ValidRelation<TClients, TDb, T, R[K]> },
      options?: PopulateOptions,
    ) => Promise<Array<T & JoinedFields<TClients, TDb, R>>>;
    /** Raw `db()` handle escape hatch. */
    client: Db;
    /** Reference to sibling managers (cross-DB). */
    db: Record<string, unknown>;
  };

/** Assemble one database's `CollectionManager` from the shared deps. */
export const buildManager = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  deps: BuildManagerDeps<TClients>,
  dbKey: TDb,
  dbName: string,
  client: MongoClient,
): CollectionManager<TClients, TDb> => {
  const { dbClients, config, logger, sharedCache, dedupeReads, inFlight, collectionRefs } = deps;
  const definition = dbClients[dbKey]!;
  const handle = client.db(dbName);
  const baseResolveCollectionName = createResolveCollectionName(definition);

  // Normalize each collection: schema-or-definition → { schema, indexes, hooks }.
  const registry = new Map<string, ReturnType<typeof asCollectionDefinition>>();
  const hooks: HooksRegistry = {};
  const timestamps: TimestampsByCollection = {};
  for (const [logical, value] of Object.entries(definition.collections)) {
    const def = asCollectionDefinition(value as CollectionLike);
    registry.set(logical, def);
    hooks[logical] = def.hooks as HooksRegistry[string];
    if (def.timestamps) timestamps[logical] = def.timestamps;
    // Cache-invalidation watchers track the PHYSICAL name (that's what cache
    // keys use), so writes to the raw collection invalidate the right reads.
    collectionRefs.push({ db: handle, collection: baseResolveCollectionName(logical) });
  }
  const getDefinition = (logical: string) => registry.get(logical);

  // Fail fast with a clear message on unknown collection names. The type
  // system rejects them at compile time; this catches plain-JS callers
  // instead of surfacing an obscure driver error (or an empty result).
  // Internal `_`-prefixed collections (e.g. the `_migrations` journal) are
  // allowed through.
  const resolveCollectionName = (logical: string): string => {
    if (!registry.has(logical) && !logical.startsWith("_")) {
      throw new BadRequest(`Unknown collection "${logical}"`);
    }
    return baseResolveCollectionName(logical);
  };

  const crud = makeCrudOps<TClients, TDb>(handle, dbName, logger, {
    resolveCollectionName,
    wrapMongoErrors: deps.wrapMongoErrors,
    ...(sharedCache !== undefined ? { cache: sharedCache } : {}),
    dedupeReads,
    inFlight,
    hooks,
    timestamps,
    ...(deps.drift !== undefined ? { drift: deps.drift } : {}),
    ...(getDefinition !== undefined
      ? { getSchema: (logical: string) => getDefinition(logical)?.schema }
      : {}),
  });
  const pagination = makePaginationOps<TClients, TDb>(handle, dbName, logger, {
    resolveCollectionName,
    wrapMongoErrors: deps.wrapMongoErrors,
    ...(deps.drift !== undefined ? { drift: deps.drift } : {}),
    ...(getDefinition !== undefined
      ? { getSchema: (logical: string) => getDefinition(logical)?.schema }
      : {}),
    ...(sharedCache !== undefined ? { cache: sharedCache } : {}),
    dedupeReads,
    inFlight,
  });
  const aggregation = makeAggregationOps<TClients, TDb>(handle, dbName, logger, {
    resolveCollectionName,
    wrapMongoErrors: deps.wrapMongoErrors,
    ...(sharedCache !== undefined ? { cache: sharedCache } : {}),
    dedupeReads,
    inFlight,
  });
  const schema = makeSchemaOps(handle, logger, { resolveCollectionName, getDefinition });
  const transactionOps = makeTransactionOps(client, handle, logger, config, {
    migrationCollectionPhysical: resolveCollectionName("_migrations"),
    wrapMongoErrors: deps.wrapMongoErrors,
  });
  const populator = makePopulator({
    findMany: async (logical, filter, options) => {
      const physical = resolveCollectionName(logical);
      return handle
        .collection<Document>(physical)
        .find(filter, {
          ...(options?.projection !== undefined ? { projection: options.projection } : {}),
          limit: options?.limit ?? 10_000,
        })
        .toArray();
    },
  });
  const populate = (async <const T extends Document, const R extends readonly RelationDef[]>(
    docs: T[],
    relations: R & { [K in keyof R]: ValidRelation<TClients, TDb, T, R[K]> },
    options: PopulateOptions = {},
  ): Promise<Array<T & JoinedFields<TClients, TDb, R>>> => {
    const result = await populator.populate(docs, relations as unknown as RelationDef[], options);
    return result as Array<T & JoinedFields<TClients, TDb, R>>;
  }) as CollectionManager<TClients, TDb>["populate"];

  return {
    ...crud,
    ...pagination,
    ...aggregation,
    ...schema,
    ...transactionOps,
    populate,
    client: handle,
    db: deps.db,
  };
};

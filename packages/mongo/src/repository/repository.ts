/**
 * Optional repository layer over a `CollectionManager` — a thin, domain-typed
 * convenience wrapper. The op-based core API is unchanged; a repository just
 * binds a manager + collection name so call sites don't repeat the collection
 * literal, and adds small ergonomic helpers (`getById`, `getByIds`,
 * `updateVersioned`, `exists`, …).
 *
 * There is deliberately NO change tracking / unit-of-work: `getById` → mutate →
 * `update`/`updateVersioned` is explicit, matching the core op semantics. All
 * perf features (cache, dedup, batching, populate) and collection hooks /
 * timestamps apply transparently because every method delegates to the manager.
 */
import type {
  AggregationCursor,
  ChangeStream,
  ChangeStreamOptions,
  DeleteResult,
  Document,
  FindOneAndUpdateOptions,
  InsertManyResult,
  InsertOneOptions,
  InsertOneResult,
  UpdateOptions,
  UpdateResult,
} from "mongodb";
import type { PopulateOptions } from "../relation/populate.ts";
import type { JoinedFields, RelationDef, ValidRelation } from "../relation/relation.ts";
import type { AggregationStages } from "../service/aggregation-stages.ts";
import type {
  FindQueryOptions,
  InsertInput,
  VersionedUpdateResult,
} from "../service/crud/index.ts";
import type { CollectionManager } from "../service/index.ts";
import type {
  CursorPage,
  CursorPaginationConfig,
  PaginationConfig,
} from "../service/pagination/index.ts";
import type { PipelineBuilder } from "../service/pipeline-builder.ts";
import type { QueryOptions } from "../service/query-options.ts";
import type { UpdateInput } from "../service/update-types.ts";
import type { FilterInput } from "../shared/filter-types.ts";
import type { PaginationResult } from "../shared/pagination-result.ts";
import type {
  DbClientsDefinition,
  ExtractCollectionNames,
  ExtractCollectionType,
  ExtractDbNames,
} from "../types.ts";

export interface RepositoryOptions {
  /** Default `findMany` limit (defaults to the ORM's `DEFAULT_FIND_LIMIT`). */
  limit?: number;
}

/** Repository for one collection — type is derived from the manager + name. */
export type Repository<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C extends ExtractCollectionNames<TClients, TDb>,
> = RepositoryFor<TClients, TDb, C, ExtractCollectionType<TClients, TDb, C>>;

type RepositoryFor<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C extends ExtractCollectionNames<TClients, TDb>,
  Doc extends Document,
> = {
  readonly collection: C;
  /** The underlying manager — escape hatch to any op. */
  readonly manager: CollectionManager<TClients, TDb>;

  /* reads */
  /** Fetch one doc by primary key, or `null`. */
  getById(id: Doc["_id"], options?: FindQueryOptions<Doc>): Promise<Doc | null>;
  /** Fetch many docs by primary key (`$in`). */
  getByIds(ids: readonly Doc["_id"][], options?: FindQueryOptions<Doc>): Promise<Doc[]>;
  /** Fetch one doc by filter, or `null`. */
  findOne(filter?: FilterInput<Doc>, options?: FindQueryOptions<Doc>): Promise<Doc | null>;
  /** Fetch one doc by filter or throw `NOT_FOUND`. */
  findOneOrFail(filter?: FilterInput<Doc>, options?: FindQueryOptions<Doc>): Promise<Doc>;
  /** Fetch many docs (default limit from `RepositoryOptions.limit`). */
  findMany(filter?: FilterInput<Doc>, options?: FindQueryOptions<Doc>): Promise<Doc[]>;
  /** Fetch many non-soft-deleted docs. */
  findActive(filter?: FilterInput<Doc>, options?: FindQueryOptions<Doc>): Promise<Doc[]>;
  /** Count docs matching a filter. */
  count(filter?: FilterInput<Doc>, options?: QueryOptions): Promise<number>;
  /** Whether at least one doc matches. */
  exists(filter?: FilterInput<Doc>, options?: FindQueryOptions<Doc>): Promise<boolean>;
  /** Distinct values of `field`. */
  distinct<K extends keyof Doc>(
    field: K,
    filter?: FilterInput<Doc>,
    options?: FindQueryOptions<Doc>,
  ): Promise<Array<Doc[K]>>;

  /* writes */
  /** Insert one doc. */
  create(
    doc: InsertInput<Doc>,
    options?: InsertOneOptions & QueryOptions,
  ): Promise<InsertOneResult<Doc>>;
  /** Insert many docs. */
  createMany(
    docs: readonly InsertInput<Doc>[],
    options?: QueryOptions,
  ): Promise<InsertManyResult<Doc>>;
  /** Update one doc by primary key. */
  update(
    id: Doc["_id"],
    patch: UpdateInput<Doc>,
    options?: UpdateOptions & QueryOptions,
  ): Promise<UpdateResult<Doc>>;
  /** Optimistic-lock update by primary key (`__v` CAS). */
  updateVersioned(
    id: Doc["_id"],
    patch: UpdateInput<Doc>,
    options?: FindOneAndUpdateOptions & QueryOptions,
  ): Promise<VersionedUpdateResult<Doc>>;
  /** Delete one doc by primary key. */
  deleteById(id: Doc["_id"], options?: QueryOptions): Promise<DeleteResult>;
  /** Soft-delete one doc by primary key (sets `deletedAt`). */
  softDelete(id: Doc["_id"], options?: QueryOptions): Promise<UpdateResult<Doc>>;

  /* pagination */
  /** `$facet` pagination with totals (one round trip). */
  page(filter: FilterInput<Doc>, config?: PaginationConfig): Promise<PaginationResult<Doc>>;
  /** Keyset/cursor pagination (O(log n), no totals). */
  pageCursor(filter: FilterInput<Doc>, config: CursorPaginationConfig): Promise<CursorPage<Doc>>;

  /* aggregation */
  /** Type-safe chained aggregation builder. */
  pipeline(options?: QueryOptions): PipelineBuilder<TClients, TDb, Doc>;
  /** Callback aggregation over a typed stage builder. */
  aggregate(
    stages: (s: AggregationStages<Doc, TClients, TDb>) => Document[],
    options?: QueryOptions,
  ): Promise<AggregationCursor<Document>>;

  /* relations */
  /** DataLoader-batched relation population (no N+1). */
  populate<const T extends Document, const R extends readonly RelationDef[]>(
    docs: T[],
    relations: R & { [K in keyof R]: ValidRelation<TClients, TDb, T, R[K]> },
    options?: PopulateOptions,
  ): Promise<Array<T & JoinedFields<TClients, TDb, R>>>;

  /* realtime */
  /** Change stream (caller-owned — attach `error` listener + close). */
  watch(pipeline?: Document[], options?: ChangeStreamOptions): ChangeStream<Doc>;
};

/**
 * Bind a repository to a manager + collection. `Doc` is inferred from the
 * collection name — no `<TDoc>` at call sites.
 */
export const createRepository = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C extends ExtractCollectionNames<TClients, TDb>,
>(
  manager: CollectionManager<TClients, TDb>,
  collection: C,
  options: RepositoryOptions = {},
): Repository<TClients, TDb, C> => {
  const repo: Repository<TClients, TDb, C> = {
    collection,
    manager,

    getById: (id, o) => manager.getOne(collection, { _id: id }, o),
    getByIds: (ids, o) => manager.findMany(collection, { _id: { $in: ids } }, o),
    findOne: (filter, o) => manager.getOne(collection, filter, o),
    findOneOrFail: (filter, o) => manager.getOneOrFail(collection, filter, o),
    findMany: (filter, o) =>
      manager.findMany(collection, filter, {
        ...(o ?? {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
    findActive: (filter, o) => manager.findActive(collection, filter, o),
    count: (filter, o) => manager.countDocuments(collection, filter, o),
    exists: async (filter, o) =>
      (await manager.getOne(collection, filter, { ...(o ?? {}), projection: { _id: 1 } })) !== null,
    distinct: (field, filter, o) => manager.distinct(collection, field, filter, o),

    create: (doc, o) => manager.insertOne(collection, doc, o),
    createMany: (docs, o) => manager.insertMany(collection, docs, o),
    update: (id, patch, o) => manager.updateOne(collection, { _id: id }, patch, o),
    updateVersioned: (id, patch, o) => manager.updateWithVersion(collection, { _id: id }, patch, o),
    deleteById: (id, o) => manager.deleteOne(collection, { _id: id }, o),
    softDelete: (id, o) => manager.softDeleteOne(collection, { _id: id }, o),

    page: (filter, config) => manager.paginateFlexible(collection, filter, config),
    pageCursor: (filter, config) => manager.paginateCursor(collection, filter, config),

    pipeline: (o) => manager.pipeline(collection, o),
    aggregate: (stages, o) => manager.aggregate(collection, stages, o),

    // The repository's public signature already validates `relations` at the
    // call site; the manager's mapped-type param can't be re-inferred here
    // (TS mapped-type inference friction), so delegate through the validated
    // shape without weakening the public type.
    populate: (docs, relations, o) => manager.populate(docs, relations as never, o),

    watch: (pipeline, options) => manager.watchCollection(collection, pipeline, options),
  };
  return repo;
};

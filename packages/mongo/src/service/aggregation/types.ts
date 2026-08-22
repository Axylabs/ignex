/**
 * Aggregation types + the shared context handed to the aggregation op-group
 * factories (`./aggregate.ts`, `./group.ts`, `./text-search.ts`,
 * `./lookup-join.ts`). Type-only plus the `AggregationCtx` interface.
 */
import type { AggregateOptions, ClientSession, Collection, Db, Document, Hint } from "mongodb";
import type { InFlight } from "../../cache/in-flight.ts";
import type { QueryCache } from "../../cache/query-cache.ts";
import type {
  DbClientsDefinition,
  ExtractCollectionNames,
  ExtractCollectionType,
  ExtractDbNames,
} from "../../types.ts";
import type { LoggerLike } from "../../utils/logger.ts";
import type { OpDeps } from "../op-deps.ts";
import type { QueryOptions, ResolvedQueryOptions } from "../query-options.ts";

export interface GroupByConfig {
  /** Group key: a field name or a document of `$`-expressions. */
  groupBy: string | Record<string, unknown>;
  /** Accumulator expressions, e.g. `{ revenue: { $sum: '$total' } }`. */
  accumulate?: Record<string, unknown>;
  /** Sort the grouped output. */
  sort?: Record<string, 1 | -1>;
  /** Cap the number of groups returned. */
  limit?: number;
}

export interface DateRangeConfig {
  /** Date field to bucket on (must exist on every doc). */
  dateField: string;
  /** Inclusive range start. */
  startDate: Date;
  /** Inclusive range end. */
  endDate: Date;
  /** Bucket granularity (default `day`). */
  granularity?: "hour" | "day" | "week" | "month" | "year";
}

export interface LookupConfig {
  /** Related (logical) collection to join. */
  fromCollection: string;
  /** Field on the source docs holding the foreign key. */
  localField: string;
  /** Field on the foreign docs to match. */
  foreignField: string;
  /** Output field name for the joined array. */
  as: string;
  /** Optional `$pipeline` limiting/filtering the joined docs. */
  pipeline?: Document[];
  /** When true, `$unwind` the joined array (preserving nulls). */
  unwindSingle?: boolean;
}

export interface PipelineCustomization {
  /** Stages prepended before the generated aggregation. */
  prePipeline?: Document[];
  /** Stages appended after the generated aggregation. */
  postPipeline?: Document[];
}

export type AggregationDocOf<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C extends ExtractCollectionNames<TClients, TDb>,
> = ExtractCollectionType<TClients, TDb, C>;

export interface AggregationOpsOptions {
  resolveCollectionName: (logical: string) => string;
  wrapMongoErrors?: boolean;
  /** Shared read cache (`undefined` = caching disabled). */
  cache?: QueryCache;
  /** Service default for in-flight read dedup. */
  dedupeReads: boolean;
  /** Shared in-flight dedup (`undefined` = no dedup). */
  inFlight?: InFlight;
}

/**
 * The cached-aggregation runner every materializing op uses (see
 * `cached-read.ts`). Caches results in the shared `QueryCache` (write-through,
 * invalidated per source collection) and dedupes identical in-flight calls.
 */
export type CachedAggregate = <X extends string, T>(input: {
  collection: X;
  opName: string;
  pipeline: Document[];
  options?: AggregateOptions & QueryOptions;
  /** Additional LOGICAL source collections (e.g. `lookupJoin` fromCollections). */
  sources?: string[];
  execute: (resolved: ResolvedQueryOptions) => Promise<T>;
}) => Promise<T>;

/** SDK option subset aggregation stages honor (merged into driver options). */
export interface AggregationSdkOptions {
  session?: ClientSession;
  maxTimeMS?: number;
  hint?: Hint;
  batchSize?: number;
}

/** Shared helpers every aggregation op needs, bundled by `makeAggregationOps`. */
export interface AggregationCtx<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
> {
  client: Db;
  dbLabel: string;
  logger: LoggerLike;
  opts: AggregationOpsOptions;
  resolve: (logical: string) => string;
  /** The defineCrudOp pipeline deps (trace + meta). */
  deps: OpDeps<ExtractCollectionNames<TClients, TDb>>;
  /** Raw driver collection handle for a logical collection. */
  coll: (collection: ExtractCollectionNames<TClients, TDb>) => Collection<Document>;
  /** Merge driver opts + SDK opts into a full `AggregateOptions`. */
  mergeAggOptions: (
    driverOpts: Record<string, unknown>,
    sdk: AggregationSdkOptions,
  ) => AggregateOptions;
  /** Cached-aggregation runner (write-through cache + dedup) for materialized ops. */
  cachedAggregate: CachedAggregate;
}

/** Pagination subset used by `textSearch`. */
export interface TextSearchPagination {
  page?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
  maxLimit?: number;
}

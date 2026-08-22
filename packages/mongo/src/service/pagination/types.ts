/**
 * Pagination types + the shared context handed to the two pagination
 * strategies (`./offset.ts`, `./cursor.ts`). Type-only plus the `PaginationCtx`
 * interface, so the strategy modules and the composing `makePaginationOps`
 * (in `./index.ts`) share one vocabulary without importing each other's logic.
 */
import type { Db, Document } from "mongodb";
import type { InFlight } from "../../cache/in-flight.ts";
import type { QueryCache } from "../../cache/query-cache.ts";
import type { ObjectField } from "../../schema/types.ts";
import type { DriftMode } from "../../schema/validate-doc/index.ts";
import type {
  DbClientsDefinition,
  ExtractCollectionNames,
  ExtractCollectionType,
  ExtractDbNames,
} from "../../types.ts";
import type { LoggerLike } from "../../utils/logger.ts";
import type { CachedAggregate } from "../aggregation/types.ts";
import type { QueryOptions } from "../query-options.ts";
import type { DbOpMeta } from "../trace-db-op.ts";

export interface PaginationConfig {
  page?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
  /** Cap on the requested limit (default DEFAULT_MAX_LIMIT=1000). */
  maxLimit?: number;
  /** Stages prepended to the data facet (e.g. extra $match). */
  prePipeline?: Document[];
  /** Stages appended inside the data facet. */
  postPipeline?: Document[];
  queryOptions?: QueryOptions;
}

export interface CursorPaginationConfig {
  limit?: number;
  /**
   * Sort keys (1 ascending / -1 descending). MUST include a unique tiebreaker —
   * typically `_id` — so cursor boundaries are unambiguous. Sort fields should
   * exist on every document for deterministic ordering.
   */
  sort: Record<string, 1 | -1>;
  /** Opaque cursor from a previous `nextCursor` — fetch the page after it. */
  after?: string;
  /** Opaque cursor — fetch the page before it (backward navigation). */
  before?: string;
  /** Cap on the requested limit (default DEFAULT_MAX_LIMIT). */
  maxLimit?: number;
  queryOptions?: QueryOptions;
}

export interface CursorPage<T> {
  data: T[];
  /** Opaque cursor for the next page in the queried direction, or null when exhausted. */
  nextCursor: string | null;
  /** True when another page exists in the queried direction. */
  hasMore: boolean;
}

export type PaginationDocOf<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C extends ExtractCollectionNames<TClients, TDb>,
> = ExtractCollectionType<TClients, TDb, C>;

export interface PaginationOpsOptions {
  resolveCollectionName: (logical: string) => string;
  wrapMongoErrors?: boolean;
  /** Service-level schema-drift policy for reads (default `'report'`). */
  drift?: DriftMode;
  /** Resolve the declared schema for a logical collection (drift detection). */
  getSchema?: (logical: string) => ObjectField | undefined;
  /** Shared read cache (`undefined` = caching disabled). */
  cache?: QueryCache;
  /** Service default for in-flight read dedup. */
  dedupeReads: boolean;
  /** Shared in-flight dedup (`undefined` = no dedup). */
  inFlight?: InFlight;
}

/** Shared helpers every pagination strategy needs, bundled by `makePaginationOps`. */
export interface PaginationCtx<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
> {
  client: Db;
  dbLabel: string;
  logger: LoggerLike;
  opts: PaginationOpsOptions;
  resolve: (logical: string) => string;
  /** The defineCrudOp pipeline deps (trace + meta). */
  deps: {
    trace: <T>(meta: DbOpMeta, fn: () => T | Promise<T>) => Promise<T>;
    meta: (collection: ExtractCollectionNames<TClients, TDb>, op: string) => DbOpMeta;
  };
  /**
   * Cached-aggregation runner — used by `paginateFlexible` (a `$facet`
   * aggregation) for write-through caching + dedup. `paginateCursor` is a
   * find-based keyset read and stays uncached (its opaque cursor pages are
   * largely unique, so caching has little to offer).
   */
  cachedAggregate: CachedAggregate;
}

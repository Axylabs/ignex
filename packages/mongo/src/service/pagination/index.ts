/**
 * Pagination op factory — `makePaginationOps`. Composes the two pagination
 * strategies into one op set per database:
 *
 *   - `./offset.ts` — `paginateFlexible` (single `$facet` round-trip, with totals)
 *   - `./cursor.ts` — `paginateCursor` (keyset / cursor, O(log n) per page)
 *
 * Both share a small context (`./types.ts`) built here.
 */
import type { Db } from "mongodb";
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from "../../types.ts";
import type { LoggerLike } from "../../utils/logger.ts";
import { createCachedAggregate } from "../aggregation/cached-read.ts";
import { makeOpDeps } from "../op-deps.ts";
import { makePaginateCursor } from "./cursor.ts";
import { makePaginateFlexible } from "./offset.ts";
import type { PaginationCtx, PaginationOpsOptions } from "./types.ts";

/**
 * Pagination ops for one database: `paginateFlexible` (offset, `$facet`) and
 * `paginateCursor` (keyset). Both are collection-name first and schema-typed.
 * `paginateFlexible` routes through the shared cached-aggregation runner
 * (write-through cache + dedup); `paginateCursor` is a find-based keyset read
 * and stays uncached (its opaque cursor pages are largely unique).
 */
export const makePaginationOps = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  client: Db,
  dbLabel: string,
  logger: LoggerLike,
  opts: PaginationOpsOptions,
) => {
  type C = ExtractCollectionNames<TClients, TDb>;

  const resolve = opts.resolveCollectionName;
  const deps = makeOpDeps<C>(logger, dbLabel, resolve, opts.wrapMongoErrors === true);

  const ctx: PaginationCtx<TClients, TDb> = {
    client,
    dbLabel,
    logger,
    opts,
    resolve,
    deps,
    cachedAggregate: createCachedAggregate<C>({ client, deps, opts, resolve }),
  };

  return {
    ...makePaginateFlexible<TClients, TDb>(ctx),
    ...makePaginateCursor<TClients, TDb>(ctx),
  };
};

// Re-export the public pagination types so the folder barrel matches the old
// single-module exports.
export type {
  CursorPage,
  CursorPaginationConfig,
  PaginationConfig,
  PaginationOpsOptions,
} from "./types.ts";

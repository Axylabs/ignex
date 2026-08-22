/**
 * Aggregation op factory — `makeAggregationOps`. Composes the aggregation op
 * groups into one set per database:
 *
 *   - `./aggregate.ts`    — `aggregate` (callback stage API) + `pipeline` (typed builder)
 *   - `./group.ts`        — `groupBy` + `dateRangeAnalysis`
 *   - `./text-search.ts`  — `textSearch`
 *   - `./lookup-join.ts`  — `lookupJoin`
 *
 * All share a context (`./types.ts`) and the merged-options/date-format
 * helpers (`./helpers.ts`) built here.
 */
import type { Db, Document } from "mongodb";
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from "../../types.ts";
import type { LoggerLike } from "../../utils/logger.ts";
import { makeOpDeps } from "../op-deps.ts";
import { makeAggregateOps } from "./aggregate.ts";
import { createCachedAggregate } from "./cached-read.ts";
import { makeGroupOps } from "./group.ts";
import { mergeAggOptions } from "./helpers.ts";
import { makeLookupJoinOp } from "./lookup-join.ts";
import { makeTextSearchOp } from "./text-search.ts";
import type { AggregationCtx, AggregationOpsOptions } from "./types.ts";

/**
 * Aggregation ops for one database: `aggregate`, `pipeline`, `groupBy`,
 * `textSearch`, `dateRangeAnalysis`, `lookupJoin`. All collection-name first
 * and schema-typed. Materializing ops (`pipeline().toArray()/.first()`,
 * `groupBy`, `dateRangeAnalysis`, `textSearch`, `lookupJoin`) route through the
 * shared cached-aggregation runner (`cachedAggregate`) — write-through cache +
 * in-flight dedup, invalidated per source collection. `aggregate()` and
 * `pipeline().cursor()` stream live cursors and stay uncached.
 */
export const makeAggregationOps = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  client: Db,
  dbLabel: string,
  logger: LoggerLike,
  opts: AggregationOpsOptions,
) => {
  type C = ExtractCollectionNames<TClients, TDb>;

  const resolve = opts.resolveCollectionName;
  const deps = makeOpDeps<C>(logger, dbLabel, resolve, opts.wrapMongoErrors === true);
  const coll = (collection: C) => client.collection<Document>(resolve(String(collection)));

  const ctx: AggregationCtx<TClients, TDb> = {
    client,
    dbLabel,
    logger,
    opts,
    resolve,
    deps,
    coll,
    mergeAggOptions,
    cachedAggregate: createCachedAggregate<C>({ client, deps, opts, resolve }),
  };

  return {
    ...makeAggregateOps<TClients, TDb>(ctx),
    ...makeGroupOps<TClients, TDb>(ctx),
    ...makeTextSearchOp<TClients, TDb>(ctx),
    ...makeLookupJoinOp<TClients, TDb>(ctx),
  };
};

// Re-export the public aggregation types so the folder barrel matches the old
// single-module exports.
export type {
  AggregationOpsOptions,
  DateRangeConfig,
  GroupByConfig,
  LookupConfig,
  PipelineCustomization,
} from "./types.ts";

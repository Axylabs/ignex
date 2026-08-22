/**
 * CRUD op factory — `makeCrudOps` — and the public CRUD types.
 *
 * `makeCrudOps` is the composition root of the CRUD layer: it builds ONE shared
 * context (`createCrudContext` in `./context.ts`) and spreads the three op
 * groups it produces:
 *
 *   - `makeReadOps`   → every read op (cache/dedup/drift pipeline)
 *   - `makeWriteOps`  → every write op (hooks + timestamps + cache invalidation)
 *   - `makeWatchOps`  → change streams + fluent query builder
 *
 * The public surface (method names, signatures, exported types) is identical to
 * the historical single-file `crud.ts` — this is a pure organizational split.
 */
import type { Db } from "mongodb";
import type { DbClientsDefinition, ExtractDbNames } from "../../types.ts";
import type { LoggerLike } from "../../utils/logger.ts";
import { type CrudOpsOptions, createCrudContext } from "./context.ts";
import { makeReadOps } from "./read-ops.ts";
import { makeWatchOps } from "./watch-ops.ts";
import { makeWriteOps } from "./write-ops.ts";

/**
 * Build the CRUD operation set for one database. Every method is collection-name
 * first and schema-typed (no `<TDoc>` at call sites). Reads go through the
 * cache + in-flight dedup path; writes invalidate the cache for that collection
 * and fire lifecycle hooks.
 */
export const makeCrudOps = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  client: Db,
  dbLabel: string,
  logger: LoggerLike,
  opts: CrudOpsOptions,
) => {
  const ctx = createCrudContext<TClients, TDb>(client, dbLabel, logger, opts);
  const readOps = makeReadOps<TClients, TDb>(ctx);
  return {
    ...readOps,
    ...makeWriteOps<TClients, TDb>(ctx, readOps),
    ...makeWatchOps<TClients, TDb>(ctx),
  };
};

export type CrudOps<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
> = ReturnType<typeof makeCrudOps<TClients, TDb>>;

// Re-export the public CRUD types so `makeCrudOps` consumers get the full
// surface from the folder barrel, matching the old single-module exports.
export type {
  CrudContext,
  CrudOpsOptions,
  FindQueryOptions,
  InsertInput,
  TimestampsByCollection,
  VersionedUpdateResult,
} from "./context.ts";
export type { ReadOps } from "./read-ops.ts";
export type { WatchOps } from "./watch-ops.ts";
export type { WriteOps } from "./write-ops.ts";

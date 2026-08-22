/**
 * Watch/query-builder op group: `watchCollection` (caller-owned change stream)
 * and `query` (the fluent `QueryBuilder` entry point, whose reads flow through
 * the shared cache + dedup pipeline).
 *
 * Composed into `makeCrudOps` (see `./index.ts`).
 */
import type { ChangeStream, ChangeStreamOptions, Document, FindOptions } from "mongodb";
import { QueryBuilder } from "../../query-builder/query-builder.ts";
import type { FilterInput } from "../../shared/filter-types.ts";
import type { QueryOptions } from "../query-options.ts";
import type { ColNames, CrudContext, DocOf } from "./context.ts";

/** Watch/query ops produced for one database by `makeWatchOps`. */
export type WatchOps<
  TClients extends import("../../types.ts").DbClientsDefinition,
  TDb extends import("../../types.ts").ExtractDbNames<TClients>,
> = ReturnType<typeof makeWatchOps<TClients, TDb>>;

/** Build the watch + query-builder op set from the shared CRUD context. */
export const makeWatchOps = <
  TClients extends import("../../types.ts").DbClientsDefinition,
  TDb extends import("../../types.ts").ExtractDbNames<TClients>,
>(
  ctx: CrudContext<TClients, TDb>,
) => {
  type C = ColNames<TClients, TDb>;
  type DocOf2<X extends C> = DocOf<TClients, TDb, X>;

  const { client, resolve, coll, read } = ctx;

  /**
   * Open a change stream on a collection. The returned `ChangeStream` is owned
   * by the caller — attach an `'error'` listener and call `.close()` when done
   * so a fire-and-forget stream never becomes an unhandled rejection.
   */
  const watchCollection = <X extends C>(
    collection: X,
    pipeline?: Document[],
    options?: ChangeStreamOptions,
  ): ChangeStream<DocOf2<X>> => coll(collection).watch(pipeline, options);

  /** Fluent query builder entry point. Reads flow through the cache + dedup pipeline. */
  const query = <X extends C>(collection: X): QueryBuilder<DocOf2<X>> => {
    const physical = resolve(String(collection));
    const handle = client.collection<DocOf2<X>>(physical);
    return new QueryBuilder<DocOf2<X>>({
      physicalName: physical,
      collection: handle,
      run: async <T>(
        opName: string,
        filter: FilterInput<DocOf2<X>>,
        execute: (driverOpts: FindOptions) => Promise<T>,
        options?: QueryOptions,
      ): Promise<T> =>
        read(
          collection,
          opName,
          filter,
          options,
          async (r) => {
            const opts: FindOptions = {
              ...(r.driverOpts as FindOptions),
              ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
              ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
              ...(r.sdk.hint !== undefined ? { hint: r.sdk.hint } : {}),
            };
            return execute(opts);
          },
          opName === "mongo.getOne" ? "one" : opName === "mongo.findMany" ? "many" : "none",
        ),
    });
  };

  return {
    watchCollection,
    query,
  };
};

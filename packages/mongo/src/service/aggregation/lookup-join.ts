/**
 * Join aggregation op — `lookupJoin`: `$lookup` one or more related
 * (logical) collections, optionally `$unwind`-ing the joined arrays (preserving
 * nulls). Single-collection hops built declaratively from `LookupConfig[]`.
 */
import type { AggregateOptions, Document } from "mongodb";
import type { FilterInput } from "../../shared/filter-types.ts";
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from "../../types.ts";
import type { QueryOptions } from "../query-options.ts";
import type {
  AggregationCtx,
  AggregationDocOf,
  LookupConfig,
  PipelineCustomization,
} from "./types.ts";

/** Build `lookupJoin` from the shared aggregation context. */
export const makeLookupJoinOp = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  ctx: AggregationCtx<TClients, TDb>,
) => {
  type C = ExtractCollectionNames<TClients, TDb>;
  type DocOf2<X extends C> = AggregationDocOf<TClients, TDb, X>;

  const { coll, mergeAggOptions, resolve, cachedAggregate } = ctx;

  /** Join related docs via `$lookup` + optional `$unwind` (single collection hop). */
  const lookupJoin = async <X extends C, TResult extends Document = DocOf2<X>>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    lookups: LookupConfig[],
    customization: PipelineCustomization = {},
    options?: AggregateOptions & QueryOptions,
  ): Promise<TResult[]> => {
    const pipeline: Document[] = [
      ...(customization.prePipeline ?? []),
      { $match: baseFilter },
      ...lookups.map((lookup) => ({
        $lookup: {
          from: resolve(lookup.fromCollection),
          localField: lookup.localField,
          foreignField: lookup.foreignField,
          as: lookup.as,
          ...(lookup.pipeline ? { pipeline: lookup.pipeline } : {}),
        },
      })),
      ...lookups
        .filter((lookup) => lookup.unwindSingle)
        .map((lookup) => ({
          $unwind: { path: `$${lookup.as}`, preserveNullAndEmptyArrays: true },
        })),
      ...(customization.postPipeline ?? []),
    ];
    return cachedAggregate<X, TResult[]>({
      collection,
      opName: "mongo.lookupJoin",
      pipeline,
      ...(options !== undefined ? { options } : {}),
      // Writes to any joined collection must invalidate the cached join.
      sources: lookups.map((l) => l.fromCollection),
      execute: (r) =>
        coll(collection)
          .aggregate<TResult>(pipeline, mergeAggOptions(r.driverOpts, r.sdk))
          .toArray(),
    });
  };

  return { lookupJoin };
};

/**
 * Low-level + typed-pipeline aggregation ops: `aggregate` (callback stage API,
 * returns a live cursor) and `pipeline` (the fully type-safe chained
 * `PipelineBuilder`). Both funnel through the shared op pipeline.
 */
import type { AggregateOptions, AggregationCursor, Document } from "mongodb";
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from "../../types.ts";
import { type AggregationStages, buildAggregationStages } from "../aggregation-stages.ts";
import type { CrudOpDeps } from "../crud-op.ts";
import { defineCrudOp } from "../crud-op.ts";
import { PipelineBuilder } from "../pipeline-builder.ts";
import type { QueryOptions } from "../query-options.ts";
import type { AggregationCtx, AggregationDocOf } from "./types.ts";

/** Build `aggregate` + `pipeline` from the shared aggregation context. */
export const makeAggregateOps = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  ctx: AggregationCtx<TClients, TDb>,
) => {
  type C = ExtractCollectionNames<TClients, TDb>;
  type DocOf2<X extends C> = AggregationDocOf<TClients, TDb, X>;

  const { deps, coll, mergeAggOptions, cachedAggregate } = ctx;

  /** Low-level aggregate: returns a live cursor wrapped in the op pipeline. */
  const aggregate = async <X extends C, TResult extends Document = Document>(
    collection: X,
    pipelineBuilder: (stages: AggregationStages<DocOf2<X>, TClients, TDb>) => Document[],
    options?: AggregateOptions & QueryOptions,
  ): Promise<AggregationCursor<TResult>> => {
    const stages = buildAggregationStages<DocOf2<X>, TClients, TDb>();
    const pipeline = pipelineBuilder(stages);
    return defineCrudOp(
      deps,
      collection,
      "mongo.aggregate",
      (r) => coll(collection).aggregate<TResult>(pipeline, mergeAggOptions(r.driverOpts, r.sdk)),
      options,
    );
  };

  /**
   * Fully type-safe, chainable pipeline builder. Each stage is typed against
   * the current document shape, `$lookup` sub-pipelines are scoped to the
   * related collection, and `$facet` branches get typed sub-builders — the
   * result type of `.toArray()` / `.first()` is inferred through the chain.
   */
  const pipeline = <const X extends C>(
    collection: X,
    options?: AggregateOptions & QueryOptions,
  ): PipelineBuilder<TClients, TDb, DocOf2<X>> =>
    new PipelineBuilder<TClients, TDb, DocOf2<X>>({
      logical: collection,
      coll: () => coll(collection),
      crudDeps: deps as unknown as CrudOpDeps<string>,
      mergeDriver: mergeAggOptions,
      ...(options !== undefined ? { options } : {}),
      cachedAggregate,
    });

  return { aggregate, pipeline };
};

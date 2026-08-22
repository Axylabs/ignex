/**
 * Grouping aggregation ops: `groupBy` (bucket by key with accumulators) and
 * `dateRangeAnalysis` (bucket a date field by hour/day/week/month/year). Both
 * build a `$group` pipeline and run it through the shared op pipeline.
 */
import type { AggregateOptions, Document } from "mongodb";
import { BadRequest } from "../../errors/index.ts";
import type { FilterInput } from "../../shared/filter-types.ts";
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from "../../types.ts";
import type { QueryOptions } from "../query-options.ts";
import { DATE_PART_FORMATS } from "./helpers.ts";
import type {
  AggregationCtx,
  AggregationDocOf,
  DateRangeConfig,
  GroupByConfig,
  PipelineCustomization,
} from "./types.ts";

/** Build `groupBy` + `dateRangeAnalysis` from the shared aggregation context. */
export const makeGroupOps = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  ctx: AggregationCtx<TClients, TDb>,
) => {
  type C = ExtractCollectionNames<TClients, TDb>;
  type DocOf2<X extends C> = AggregationDocOf<TClients, TDb, X>;

  const { coll, mergeAggOptions, cachedAggregate } = ctx;

  /** Group documents by a key with optional accumulators/sort/limit (e.g. revenue per status). */
  const groupBy = async <X extends C, TResult extends Document = Document>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    config: GroupByConfig,
    customization: PipelineCustomization = {},
    options?: AggregateOptions & QueryOptions,
  ): Promise<TResult[]> => {
    if (config.limit !== undefined && (!Number.isFinite(config.limit) || config.limit < 0)) {
      throw new BadRequest("groupBy: `limit` must be a non-negative finite number");
    }
    const pipeline: Document[] = [
      ...(customization.prePipeline ?? []),
      { $match: baseFilter },
      { $group: { _id: config.groupBy, ...(config.accumulate ?? {}) } },
      ...(config.sort && Object.keys(config.sort).length > 0 ? [{ $sort: config.sort }] : []),
      ...(config.limit !== undefined ? [{ $limit: config.limit }] : []),
      ...(customization.postPipeline ?? []),
    ];
    return cachedAggregate<X, TResult[]>({
      collection,
      opName: "mongo.groupBy",
      pipeline,
      ...(options !== undefined ? { options } : {}),
      execute: (r) =>
        coll(collection)
          .aggregate<TResult>(pipeline, mergeAggOptions(r.driverOpts, r.sdk))
          .toArray(),
    });
  };

  /** Aggregate a metric over date buckets (hour/day/week/month/year) within a range. */
  const dateRangeAnalysis = async <X extends C, TResult extends Document = Document>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    dateConfig: DateRangeConfig,
    analysisConfig: {
      accumulate?: Record<string, unknown>;
      sort?: Record<string, 1 | -1>;
      limit?: number;
    } = {},
    customization: PipelineCustomization = {},
    options?: AggregateOptions & QueryOptions,
  ): Promise<TResult[]> => {
    if (
      analysisConfig.limit !== undefined &&
      (!Number.isFinite(analysisConfig.limit) || analysisConfig.limit < 0)
    ) {
      throw new BadRequest("dateRangeAnalysis: `limit` must be a non-negative finite number");
    }
    const granularity = dateConfig.granularity ?? "day";
    const format = DATE_PART_FORMATS[granularity];
    const datePart = {
      $dateToString: { format, date: `$${dateConfig.dateField}` },
    };
    const pipeline: Document[] = [
      ...(customization.prePipeline ?? []),
      {
        $match: {
          ...baseFilter,
          [dateConfig.dateField]: { $gte: dateConfig.startDate, $lte: dateConfig.endDate },
        },
      },
      { $group: { _id: datePart, ...(analysisConfig.accumulate ?? {}) } },
      ...(analysisConfig.sort && Object.keys(analysisConfig.sort).length > 0
        ? [{ $sort: analysisConfig.sort }]
        : []),
      ...(analysisConfig.limit !== undefined ? [{ $limit: analysisConfig.limit }] : []),
      ...(customization.postPipeline ?? []),
    ];
    return cachedAggregate<X, TResult[]>({
      collection,
      opName: "mongo.dateRangeAnalysis",
      pipeline,
      ...(options !== undefined ? { options } : {}),
      execute: (r) =>
        coll(collection)
          .aggregate<TResult>(pipeline, mergeAggOptions(r.driverOpts, r.sdk))
          .toArray(),
    });
  };

  return { groupBy, dateRangeAnalysis };
};

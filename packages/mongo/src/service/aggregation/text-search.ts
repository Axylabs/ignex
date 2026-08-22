/**
 * Text-search aggregation op — `textSearch`: `$regex` (fuzzy, per-field `$or`)
 * or `$text` (`$search`, `$caseSensitive`, `$language`, `$diacriticSensitive`),
 * with `$facet` pagination and optional score sorting. Uses the search-stage
 * builders from `./aggregation-pipeline.ts`.
 */
import type { AggregateOptions, Document, Filter } from "mongodb";
import { DEFAULT_MAX_LIMIT } from "../../shared/constants.ts";
import type { FilterInput } from "../../shared/filter-types.ts";
import { normalizePageLimit } from "../../shared/pagination-math.ts";
import { buildPaginationResult, type PaginationResult } from "../../shared/pagination-result.ts";
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from "../../types.ts";
import { buildSearchStages, type SearchConfig } from "../aggregation-pipeline.ts";
import type { QueryOptions } from "../query-options.ts";
import type {
  AggregationCtx,
  AggregationDocOf,
  PipelineCustomization,
  TextSearchPagination,
} from "./types.ts";

/** Build `textSearch` from the shared aggregation context. */
export const makeTextSearchOp = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  ctx: AggregationCtx<TClients, TDb>,
) => {
  type C = ExtractCollectionNames<TClients, TDb>;
  type DocOf2<X extends C> = AggregationDocOf<TClients, TDb, X>;

  const { coll, mergeAggOptions, cachedAggregate } = ctx;

  /** Full-text / regex search with `$facet` pagination and optional score-sorting. */
  const textSearch = async <X extends C>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    searchConfig: SearchConfig,
    paginationConfig: TextSearchPagination = {},
    customization: PipelineCustomization = {},
    options?: AggregateOptions & QueryOptions,
  ): Promise<PaginationResult<DocOf2<X> & { searchScore?: number }>> => {
    const normalized = normalizePageLimit(
      {
        ...(paginationConfig.page !== undefined ? { page: paginationConfig.page } : {}),
        ...(paginationConfig.limit !== undefined ? { limit: paginationConfig.limit } : {}),
      },
      paginationConfig.maxLimit ?? DEFAULT_MAX_LIMIT,
    );
    const searchStages = buildSearchStages(
      baseFilter as unknown as Filter<DocOf2<X>>,
      searchConfig,
    );
    const pipeline: Document[] = [
      ...(customization.prePipeline ?? []),
      ...searchStages,
      {
        $facet: {
          data: [
            ...(searchConfig.sortByScore
              ? [{ $sort: { searchScore: { $meta: "textScore" } } }]
              : []),
            ...(paginationConfig.sort && Object.keys(paginationConfig.sort).length > 0
              ? [{ $sort: paginationConfig.sort }]
              : []),
            { $skip: normalized.offset },
            { $limit: normalized.limit },
            ...(customization.postPipeline ?? []),
          ],
          totalCount: [{ $count: "count" }],
        },
      },
    ];
    return cachedAggregate<X, PaginationResult<DocOf2<X> & { searchScore?: number }>>({
      collection,
      opName: "mongo.textSearch",
      pipeline,
      ...(options !== undefined ? { options } : {}),
      execute: async (r) => {
        const rows = await coll(collection)
          .aggregate(pipeline, mergeAggOptions(r.driverOpts, r.sdk))
          .toArray();
        const row = rows[0] as
          | {
              data?: Array<DocOf2<X> & { searchScore?: number }>;
              totalCount?: Array<{ count: number }>;
            }
          | undefined;
        const data = row?.data ?? [];
        const totalCount = row?.totalCount?.[0]?.count ?? 0;
        return buildPaginationResult(data, totalCount, normalized.page, normalized.limit);
      },
    });
  };

  return { textSearch };
};

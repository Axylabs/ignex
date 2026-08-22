import type { Document } from "mongodb";
import type { FilterInput } from "../shared/filter-types.ts";
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from "../types.ts";
import { normalizeSubPipeline, type PipelineBuilder, stageBuilder } from "./pipeline-builder.ts";
import type {
  ForeignDocOf,
  GeoNearSpec,
  GroupSpec,
  LookupSpecFor,
  Projection,
  SortKeys,
  UnwindSpec,
} from "./pipeline-types.ts";

/**
 * Typed aggregation-stage builder for the `db.aggregate(collection, (stages) =>
 * [...])` callback API. Each stage is validated against the source document
 * (`match` fields autocomplete and typo'd fields are compile errors), `$lookup`
 * sub-pipelines are scoped to the related collection, and `$facet` branches get
 * their own typed sub-builder. For inferred result types use the chained
 * `db.pipeline()` builder instead (`src/service/pipeline-builder.ts`).
 */
export interface AggregationStages<
  TDoc extends Document = Document,
  TClients extends DbClientsDefinition = DbClientsDefinition,
  TDb extends ExtractDbNames<TClients> = ExtractDbNames<TClients>,
> {
  match(filter: FilterInput<TDoc>): { $match: FilterInput<TDoc> };
  project(fields: Projection<TDoc>): { $project: Projection<TDoc> };
  addFields(fields: Projection<TDoc>): { $addFields: Projection<TDoc> };
  set(fields: Projection<TDoc>): { $set: Projection<TDoc> };
  unset(fields: string | string[]): { $unset: string | string[] };
  sort(sort: SortKeys<TDoc>): { $sort: SortKeys<TDoc> };
  limit(n: number): { $limit: number };
  skip(n: number): { $skip: number };
  count(field: string): { $count: string };
  group(group: GroupSpec<TDoc>): { $group: GroupSpec<TDoc> };
  /**
   * `$geoNear` — requires a `2dsphere`/`2d` index and MUST be the first stage
   * (throws otherwise).
   */
  geoNear(spec: GeoNearSpec): { $geoNear: GeoNearSpec };
  lookup<
    const F extends ExtractCollectionNames<TClients, TDb>,
    const A extends string,
    const O extends Document = ForeignDocOf<TClients, TDb, F>,
  >(
    params: LookupSpecFor<TClients, TDb, TDoc, F> & {
      as: A;
      pipeline?:
        | Document[]
        | ((
            sub: PipelineBuilder<TClients, TDb, ForeignDocOf<TClients, TDb, F>>,
          ) => PipelineBuilder<TClients, TDb, O> | Document[]);
    },
  ): { $lookup: Document };
  facet(
    facets: Record<
      string,
      Document[] | ((stages: AggregationStages<TDoc, TClients, TDb>) => Document[])
    >,
  ): { $facet: Record<string, Document[]> };
  unwind(path: UnwindSpec): { $unwind: UnwindSpec };
  fill(params: Document): { $fill: Document };
  bucket(params: Document): { $bucket: Document };
  bucketAuto(params: Document): { $bucketAuto: Document };
  densify(params: Document): { $densify: Document };
}

export const buildAggregationStages = <
  TDoc extends Document = Document,
  TClients extends DbClientsDefinition = DbClientsDefinition,
  TDb extends ExtractDbNames<TClients> = ExtractDbNames<TClients>,
>(): AggregationStages<TDoc, TClients, TDb> => {
  // Tracks emitted stages so `$geoNear` (first-stage-only) can be guarded.
  let emitted = 0;
  const mark = <T>(stage: T): T => {
    emitted++;
    return stage;
  };
  return {
    match: (filter) => mark({ $match: filter }),
    project: (fields) => mark({ $project: fields }),
    addFields: (fields) => mark({ $addFields: fields }),
    set: (fields) => mark({ $set: fields }),
    unset: (fields) => mark({ $unset: fields }),
    sort: (sort) => mark({ $sort: sort }),
    limit: (n) => mark({ $limit: n }),
    skip: (n) => mark({ $skip: n }),
    count: (field) => mark({ $count: field }),
    group: (group) => mark({ $group: group }),
    lookup: <
      const F extends ExtractCollectionNames<TClients, TDb>,
      const A extends string,
      const O extends Document = ForeignDocOf<TClients, TDb, F>,
    >(
      params: LookupSpecFor<TClients, TDb, TDoc, F> & {
        as: A;
        pipeline?:
          | Document[]
          | ((
              sub: PipelineBuilder<TClients, TDb, ForeignDocOf<TClients, TDb, F>>,
            ) => PipelineBuilder<TClients, TDb, O> | Document[]);
      },
    ): { $lookup: Document } => {
      const { pipeline, ...rest } = params;
      if (typeof pipeline === "function") {
        const sub = stageBuilder<TClients, TDb, ForeignDocOf<TClients, TDb, F>>();
        const result = (pipeline as (s: PipelineBuilder<TClients, TDb, any>) => unknown)(sub);
        return mark({
          $lookup: {
            ...rest,
            pipeline: normalizeSubPipeline(result, "$lookup"),
          },
        });
      }
      return mark({ $lookup: params });
    },
    facet: (facets) => {
      const out: Record<string, Document[]> = {};
      for (const [name, branch] of Object.entries(facets)) {
        out[name] =
          typeof branch === "function"
            ? (branch as (stages: AggregationStages<TDoc, TClients, TDb>) => Document[])(
                buildAggregationStages<TDoc, TClients, TDb>(),
              )
            : branch;
      }
      return mark({ $facet: out });
    },
    unwind: (path) => mark({ $unwind: path }),
    fill: (params) => mark({ $fill: params }),
    bucket: (params) => mark({ $bucket: params }),
    bucketAuto: (params) => mark({ $bucketAuto: params }),
    densify: (params) => mark({ $densify: params }),
    geoNear: (spec) => {
      if (emitted > 0) {
        throw new Error("aggregate.geoNear(): $geoNear must be the first pipeline stage");
      }
      return mark({ $geoNear: spec });
    },
  };
};

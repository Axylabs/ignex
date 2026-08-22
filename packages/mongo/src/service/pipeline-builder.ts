/**
 * Fully type-safe, chainable aggregation pipeline builder.
 *
 * Every stage is typed against the current document shape, so intellisense
 * follows the real schema fields and the result type of `.toArray()` /
 * `.first()` is inferred through the whole chain. `$lookup` sub-pipelines are
 * scoped to the related collection's schema and `$facet` branches get their own
 * typed sub-builder — see `src/service/pipeline-types.ts` for the type model.
 *
 *   const top = await db.pipeline('orders')
 *     .match({ status: 'paid' })
 *     .group({ _id: '$userId', total: { $sum: '$total' } })
 *     .sort({ total: -1 })
 *     .limit(3)
 *     .toArray();
 */
import type {
  AggregateOptions,
  AggregationCursor,
  ClientSession,
  Collection,
  Document,
  Hint,
} from "mongodb";
import { BadRequest } from "../errors/index.ts";
import type { FilterInput } from "../shared/filter-types.ts";
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from "../types.ts";
import type { CachedAggregate } from "./aggregation/types.ts";
import { type CrudOpDeps, defineCrudOp } from "./crud-op.ts";
import type {
  Added,
  FacetOutput,
  FacetSpec,
  ForeignDocOf,
  GeoNearOutput,
  GeoNearSpec,
  Grouped,
  GroupSpec,
  LookupJoinedFor,
  LookupSpecFor,
  Projected,
  Projection,
  SortKeys,
  Unsetted,
  UnwindSpec,
  Unwound,
} from "./pipeline-types.ts";
import type { QueryOptions, ResolvedQueryOptions } from "./query-options.ts";

/** Execution dependencies wired up by `makeAggregationOps`. */
export interface PipelineBuilderDeps {
  logical: string;
  coll: () => Collection<Document>;
  crudDeps: CrudOpDeps<string>;
  mergeDriver: (
    driverOpts: Record<string, unknown>,
    sdk: { session?: ClientSession; maxTimeMS?: number; hint?: Hint },
  ) => AggregateOptions;
  options?: AggregateOptions & QueryOptions;
  /**
   * Cached-aggregation runner (write-through cache + dedup). Present on real
   * builders so `.toArray()` / `.first()` are cached; absent on stage-only
   * builders (sub-pipelines read via `.raw()` and never execute).
   */
  cachedAggregate?: CachedAggregate;
}

export class PipelineBuilder<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  TDoc extends Document,
> {
  constructor(
    private readonly deps: PipelineBuilderDeps,
    private readonly stages: Document[] = [],
  ) {}

  /** Raw accumulated stages — embeddable into `$lookup` / `$facet` branches. */
  raw(): Document[] {
    return this.stages;
  }

  private assertNonNegativeFinite(name: string, n: number): void {
    if (!Number.isFinite(n) || n < 0) {
      throw new BadRequest(`pipeline.${name}(): ${name} must be a non-negative finite number`);
    }
  }

  /* --------------------------- shape-keeping --------------------------- */

  match(filter: FilterInput<TDoc>): this {
    this.stages.push({ $match: filter });
    return this;
  }

  sort(sort: SortKeys<TDoc>): this {
    this.stages.push({ $sort: sort });
    return this;
  }

  limit(n: number): this {
    this.assertNonNegativeFinite("limit", n);
    this.stages.push({ $limit: n });
    return this;
  }

  skip(n: number): this {
    this.assertNonNegativeFinite("skip", n);
    this.stages.push({ $skip: n });
    return this;
  }

  sample(n: number): this {
    this.assertNonNegativeFinite("sample", n);
    this.stages.push({ $sample: { size: n } });
    return this;
  }

  /**
   * `$geoNear` — requires a `2dsphere`/`2d` index and MUST be the first stage.
   * Adds the computed distance to `spec.distanceField` on every output doc.
   */
  geoNear<const S extends GeoNearSpec>(
    spec: S,
  ): PipelineBuilder<TClients, TDb, GeoNearOutput<TDoc, S>> {
    if (this.stages.length > 0) {
      throw new Error("pipeline.geoNear(): $geoNear must be the first pipeline stage");
    }
    return this.derive<GeoNearOutput<TDoc, S>>({ $geoNear: spec });
  }

  /* --------------------------- shape-changing -------------------------- */

  project<const P extends Projection<TDoc>>(
    projection: P,
  ): PipelineBuilder<TClients, TDb, Projected<TDoc, P>> {
    return this.derive<Projected<TDoc, P>>({ $project: projection });
  }

  addFields<const P extends Projection<TDoc>>(
    fields: P,
  ): PipelineBuilder<TClients, TDb, Added<TDoc, P>> {
    return this.derive<Added<TDoc, P>>({ $addFields: fields });
  }

  set<const P extends Projection<TDoc>>(fields: P): PipelineBuilder<TClients, TDb, Added<TDoc, P>> {
    return this.derive<Added<TDoc, P>>({ $set: fields });
  }

  unset<const F extends string | readonly string[]>(
    fields: F,
  ): PipelineBuilder<TClients, TDb, Unsetted<TDoc, F>> {
    return this.derive<Unsetted<TDoc, F>>({ $unset: fields });
  }

  count<const F extends string>(field: F): PipelineBuilder<TClients, TDb, { [K in F]: number }> {
    return this.derive<{ [K in F]: number }>({ $count: field });
  }

  group<const G extends GroupSpec<TDoc>>(
    group: G,
  ): PipelineBuilder<TClients, TDb, Grouped<TDoc, G>> {
    return this.derive<Grouped<TDoc, G>>({ $group: group });
  }

  unwind<const P extends UnwindSpec>(path: P): PipelineBuilder<TClients, TDb, Unwound<TDoc, P>> {
    return this.derive<Unwound<TDoc, P>>({ $unwind: path });
  }

  lookup<
    const F extends ExtractCollectionNames<TClients, TDb>,
    const A extends string,
    const O extends Document = ForeignDocOf<TClients, TDb, F>,
  >(
    spec: LookupSpecFor<TClients, TDb, TDoc, F> & {
      as: A;
      pipeline?:
        | Document[]
        | ((
            sub: PipelineBuilder<TClients, TDb, ForeignDocOf<TClients, TDb, F>>,
          ) => PipelineBuilder<TClients, TDb, O> | Document[]);
    },
  ): PipelineBuilder<TClients, TDb, LookupJoinedFor<TClients, TDb, TDoc, F, A, O>> {
    return this.derive<LookupJoinedFor<TClients, TDb, TDoc, F, A, O>>({
      $lookup: this.evalLookup(spec),
    });
  }

  facet<const F extends FacetSpec<TClients, TDb, TDoc>>(
    facets: F,
  ): PipelineBuilder<TClients, TDb, FacetOutput<TClients, TDb, TDoc, F>> {
    return this.derive<FacetOutput<TClients, TDb, TDoc, F>>({ $facet: this.evalFacets(facets) });
  }

  /* ------------------------------ terminals ---------------------------- */

  /** Run the pipeline and return every output document. */
  toArray(): Promise<TDoc[]> {
    const run = (r: ResolvedQueryOptions) =>
      this.deps
        .coll()
        .aggregate<TDoc>(this.stages, this.deps.mergeDriver(r.driverOpts, r.sdk))
        .toArray();
    if (this.deps.cachedAggregate) {
      return this.deps.cachedAggregate<string, TDoc[]>({
        collection: this.deps.logical,
        opName: "mongo.pipeline",
        pipeline: this.stages,
        ...(this.deps.options !== undefined ? { options: this.deps.options } : {}),
        execute: run,
      });
    }
    return defineCrudOp(
      this.deps.crudDeps,
      this.deps.logical,
      "mongo.pipeline",
      run,
      this.deps.options,
    );
  }

  /** Run the pipeline and return the first output document (or null). */
  async first(): Promise<TDoc | null> {
    const run = async (r: ResolvedQueryOptions) => {
      const cursor = this.deps
        .coll()
        .aggregate<TDoc>(this.stages, this.deps.mergeDriver(r.driverOpts, r.sdk));
      try {
        return await cursor.tryNext();
      } finally {
        await cursor.close();
      }
    };
    // Distinct op name so `first()` never shares a cache entry with
    // `toArray()` on the same pipeline (they would collide on the key).
    if (this.deps.cachedAggregate) {
      return this.deps.cachedAggregate<string, TDoc | null>({
        collection: this.deps.logical,
        opName: "mongo.pipeline.first",
        pipeline: this.stages,
        ...(this.deps.options !== undefined ? { options: this.deps.options } : {}),
        execute: run,
      });
    }
    return defineCrudOp(
      this.deps.crudDeps,
      this.deps.logical,
      "mongo.pipeline.first",
      run,
      this.deps.options,
    );
  }

  /** Streaming cursor (raw driver cursor; no retry / trace). */
  cursor(): AggregationCursor<TDoc> {
    return this.deps.coll().aggregate<TDoc>(this.stages, this.deps.options as AggregateOptions);
  }

  /* ------------------------------ internals ---------------------------- */

  private derive<NewDoc extends Document>(stage: Document): PipelineBuilder<TClients, TDb, NewDoc> {
    return new PipelineBuilder<TClients, TDb, NewDoc>(this.deps, [...this.stages, stage]);
  }

  private evalLookup(spec: Record<string, unknown>): Document {
    const { pipeline, ...rest } = spec;
    if (typeof pipeline === "function") {
      const sub = new PipelineBuilder<any, any, Document>(this.deps, []);
      const result = (pipeline as (s: PipelineBuilder<any, any, Document>) => unknown)(sub);
      return { ...rest, pipeline: normalizeSubPipeline(result, "$lookup") };
    }
    return spec as Document;
  }

  private evalFacets(facets: Record<string, unknown>): Record<string, Document[]> {
    const out: Record<string, Document[]> = {};
    for (const [name, branch] of Object.entries(facets)) {
      if (typeof branch === "function") {
        const sub = new PipelineBuilder<any, any, any>(this.deps, []);
        const result = (branch as (s: PipelineBuilder<any, any, any>) => unknown)(sub);
        out[name] = normalizeSubPipeline(result, `$facet.${name}`);
      } else {
        out[name] = branch as Document[];
      }
    }
    return out;
  }
}

/**
 * Normalize a sub-pipeline callback result into a raw `Document[]`.
 *
 * Sub-pipelines may be written as a CHAINED builder (`(o) => o.match(...).project(...)`)
 * or a raw array of stages. A common footgun is the array form where each element is
 * itself a builder result — `[o.match(...), o.project(...)]` — which silently produces
 * garbage stages and fails in Mongo with "must contain exactly one field" (code 40323).
 * We detect and reject that eagerly with a descriptive error.
 */
export const normalizeSubPipeline = (result: unknown, where: string): Document[] => {
  if (Array.isArray(result) && result.some((s) => s instanceof PipelineBuilder)) {
    throw new TypeError(
      `aggregation sub-pipeline (${where}) must be written as a chained builder — e.g. ` +
        "`(o) => o.match(...).project(...)` — not as an array of builder results like " +
        "`[o.match(...), o.project(...)]` (each element is a builder, not a stage).",
    );
  }
  return result instanceof PipelineBuilder ? result.raw() : (result as Document[]);
};

/**
 * Create a non-executable, stage-only builder. Used to evaluate `$lookup` /
 * `$facet` sub-pipelines in the callback `aggregate()` API — the sub-pipeline
 * is only ever read via `.raw()`, never executed.
 */
export const stageBuilder = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  TDoc extends Document,
>(): PipelineBuilder<TClients, TDb, TDoc> =>
  new PipelineBuilder<TClients, TDb, TDoc>({
    logical: "",
    coll: () => {
      throw new Error("stage-only pipeline builders cannot be executed");
    },
    crudDeps: {
      trace: () => Promise.reject(new Error("stage-only pipeline builders cannot be executed")),
      meta: () => ({ collection: "", physicalCollection: "", db: "", op: "" }),
    },
    mergeDriver: () => ({}),
  });

/**
 * Aggregation helpers shared by every op: `mergeAggOptions` (merge driver +
 * SDK options into a full `AggregateOptions`, forwarding `batchSize`), the
 * `DATE_PART_FORMATS` lookup for date-bucket `$dateToString` formats, and the
 * cache plumbing — `collectAggSources` (which source collections a pipeline
 * reads, for invalidation) and `isCacheablePipeline` (skip caching for
 * write/non-deterministic stages).
 */
import type { AggregateOptions, Document } from "mongodb";
import type { AggregationSdkOptions, DateRangeConfig } from "./types.ts";

/** Merge resolved SDK options into the driver's aggregate options. */
export const mergeAggOptions = (
  driverOpts: Record<string, unknown>,
  sdk: AggregationSdkOptions,
): AggregateOptions => ({
  ...(driverOpts as AggregateOptions),
  ...(sdk.session !== undefined ? { session: sdk.session } : {}),
  ...(sdk.maxTimeMS !== undefined ? { maxTimeMS: sdk.maxTimeMS } : {}),
  ...(sdk.hint !== undefined ? { hint: sdk.hint } : {}),
  ...(sdk.batchSize !== undefined ? { batchSize: sdk.batchSize } : {}),
});

/** `$dateToString` format per granularity for `dateRangeAnalysis`. */
export const DATE_PART_FORMATS: Record<NonNullable<DateRangeConfig["granularity"]>, string> = {
  hour: "%Y-%m-%dT%H",
  day: "%Y-%m-%d",
  week: "%Y-W%V",
  month: "%Y-%m",
  year: "%Y",
};

/**
 * Collect every SOURCE collection an aggregation pipeline reads from, so cached
 * results can be invalidated when ANY of them changes. Starts with the primary
 * collection + any additional logical sources the op knows about (e.g.
 * `lookupJoin`'s `fromCollection`s), then walks the pipeline for:
 *
 *   - `$lookup.from`            (recursing into `$lookup.pipeline`)
 *   - `$unionWith.coll`         (recursing into `$unionWith.pipeline`)
 *   - `$facet` branches         (recursing into each branch's stages)
 *
 * The returned names are resolved to physical collection keys by the caller
 * (`resolve(logical)` — a known logical name — else treated as an already
 * physical name, which is what `lookupJoin` emits).
 */
export const collectAggSources = (
  primaryLogical: string,
  pipeline: Document[],
  extraLogical: string[] = [],
): string[] => {
  const sources = new Set<string>([primaryLogical, ...extraLogical]);
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: aggregation-source walk is inherently branchy
  const visit = (stages: unknown): void => {
    if (!Array.isArray(stages)) return;
    for (const stage of stages) {
      if (!stage || typeof stage !== "object") continue;
      const s = stage as Record<string, unknown>;
      const lookup = s.$lookup as Record<string, unknown> | undefined;
      if (lookup && typeof lookup === "object") {
        if (typeof lookup.from === "string") sources.add(lookup.from);
        if (Array.isArray(lookup.pipeline)) visit(lookup.pipeline);
      }
      const union = s.$unionWith as Record<string, unknown> | undefined;
      if (union && typeof union === "object") {
        if (typeof union.coll === "string") sources.add(union.coll);
        if (Array.isArray(union.pipeline)) visit(union.pipeline);
      }
      const facet = s.$facet as Record<string, unknown> | undefined;
      if (facet && typeof facet === "object") {
        for (const branch of Object.values(facet)) visit(branch); // each branch is a stage list
      }
    }
  };
  visit(pipeline);
  return [...sources];
};

/**
 * Whether an aggregation pipeline is safe to cache. Results are NOT cached when
 * the pipeline writes (`$out` / `$merge`) or is non-deterministic (`$sample`).
 * Non-deterministic expressions beyond `$sample` (`$rand`, `$function`) are not
 * auto-detected — callers should opt out per op with `{ cache: false }`. The
 * check recurses into `$lookup.pipeline` and `$facet` branches.
 */
export const isCacheablePipeline = (pipeline: Document[]): boolean => {
  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object") continue;
    if ("$out" in stage || "$merge" in stage || "$sample" in stage) return false;
    const s = stage as Record<string, unknown>;
    const lookup = s.$lookup as { pipeline?: Document[] } | undefined;
    if (lookup && Array.isArray(lookup.pipeline) && !isCacheablePipeline(lookup.pipeline)) {
      return false;
    }
    const facet = s.$facet as Record<string, unknown> | undefined;
    if (facet && typeof facet === "object") {
      for (const branch of Object.values(facet)) {
        if (Array.isArray(branch) && !isCacheablePipeline(branch)) return false;
      }
    }
  }
  return true;
};

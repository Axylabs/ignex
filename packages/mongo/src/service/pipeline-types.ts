import type { Document } from "mongodb";
import type { GeoPoint, RemoveIndexSignature } from "../shared/types.ts";
import type {
  DbClientsDefinition,
  ExtractCollectionNames,
  ExtractCollectionType,
  ExtractDbNames,
} from "../types.ts";
import type { PipelineBuilder } from "./pipeline-builder.ts";

/**
 * Self-declared pipeline stage types (no ODM dependency). A stage is any object
 * with a `$`-operator key; `Document` is the escape hatch for custom stages.
 */
export type PipelineStage = Document;

export type FacetPipelineStage = Document;

/* ------------------------------------------------------------------ *
 * Typed spec types driving the chained `db.pipeline()` builder AND the
 * collection-typed `db.aggregate(collection, (stages) => [...])` callback
 * stages. Real schema fields autocomplete for `$match`, `$project`,
 * `$sort`, `$group`, `$lookup` sub-pipelines and `$facet` branches, and
 * result shapes are recomputed through the chain.
 * ------------------------------------------------------------------ */

/** Real top-level field names of a document (index-signature keys excluded). */
export type FieldName<T> = Extract<keyof RemoveIndexSignature<T>, string>;

/** `$`-prefixed reference to a real field, e.g. `$status`. */
export type FieldRef<T> = `$${FieldName<T>}`;

/** Value allowed in a `$project` / `$addFields` / `$set` document. */
export type ProjectionValue = boolean | number | string | null | Document;

/**
 * A `$project` / `$addFields` / `$set` spec. Known fields autocomplete;
 * arbitrary computed / new field names are allowed.
 */
export type Projection<TDoc> = {
  [K in FieldName<TDoc>]?: ProjectionValue;
} & Record<string, ProjectionValue>;

/** Result type of a single projection / expression value. */
export type ExprResult<TDoc, V> = V extends `$${infer F}`
  ? F extends FieldName<TDoc>
    ? TDoc[F & keyof TDoc]
    : unknown
  : unknown;

type IncludeKeys<P> = {
  [K in keyof P]: P[K] extends 1 ? K : P[K] extends true ? K : never;
}[keyof P];
type ExcludeKeys<P> = {
  [K in keyof P]: P[K] extends 0 ? K : P[K] extends false ? K : never;
}[keyof P];
type HasInclusions<P> = IncludeKeys<P> extends never ? false : true;
type ComputedFields<TDoc, P> = {
  [K in Exclude<keyof P, FieldName<TDoc>>]: ExprResult<TDoc, P[K]>;
};

/** Pick the included fields, keeping `_id` unless the projection drops it. */
type PickedWithId<TDoc, P> = Pick<TDoc, IncludeKeys<P> & keyof TDoc> &
  ("_id" extends keyof TDoc
    ? "_id" extends IncludeKeys<P> | ExcludeKeys<P>
      ? unknown
      : Pick<TDoc, "_id">
    : unknown);

/**
 * Output document of a `$project`. With inclusions (`1`) the output keeps only
 * those fields (+ `_id`); otherwise it is the input minus exclusions (`0`),
 * plus any computed new fields (typed when they are `$field` references).
 */
export type Projected<TDoc extends Document, P> =
  HasInclusions<P> extends true
    ? PickedWithId<TDoc, P> & ComputedFields<TDoc, P>
    : Omit<TDoc, ExcludeKeys<P> & keyof TDoc> & ComputedFields<TDoc, P>;

/** Output of `$addFields` / `$set`: the input plus added / overridden fields. */
export type Added<TDoc, P> = TDoc & { [K in keyof P]: ExprResult<TDoc, P[K]> };

/** Output of `$unset` (fields removed). */
export type Unsetted<TDoc, F> = Omit<TDoc, UnsetKeys<F> & keyof TDoc>;
type UnsetKeys<F> = F extends readonly (infer E)[]
  ? E extends string
    ? E
    : never
  : F extends string
    ? F
    : never;

/** `$sort` spec: real fields autocomplete; arbitrary paths allowed. */
export type SortKeys<TDoc> = { [K in FieldName<TDoc>]?: 1 | -1 } & Record<string, 1 | -1>;

/**
 * `$geoNear` spec — MongoDB requires `$geoNear` to be the FIRST pipeline stage
 * and a `2dsphere` (or `2d`) index on the location field.
 */
export interface GeoNearSpec {
  /** GeoJSON Point or [longitude, latitude] near which to search. */
  near: GeoPoint | [number, number];
  /** Field name written with the computed distance (meters when `spherical`). */
  distanceField: string;
  maxDistance?: number;
  minDistance?: number;
  spherical?: boolean;
  distanceMultiplier?: number;
  includeLocs?: string;
  key?: string;
  query?: Document;
}

/** Output of `$geoNear`: the input doc plus the computed distance field. */
export type GeoNearOutput<TDoc extends Document, S extends GeoNearSpec> = TDoc & {
  [K in S["distanceField"]]: number;
};

/** Value accepted by `$group` accumulators. */
export type AccumulatorSpec =
  | { $sum: number | string | Document | null }
  | { $avg: number | string | Document | null }
  | { $first: number | string | Document | null }
  | { $last: number | string | Document | null }
  | { $max: number | string | Document | null }
  | { $min: number | string | Document | null }
  | { $push: number | string | Document | null }
  | { $addToSet: number | string | Document | null }
  | { $count: Record<string, never> };

/**
 * `$group` spec: `_id` autocompletes real fields (or a bare name / `null` /
 * an arbitrary expression document); other keys are accumulators.
 */
export type GroupSpec<TDoc> = {
  _id: FieldRef<TDoc> | FieldName<TDoc> | null | Document;
} & Record<string, AccumulatorSpec | FieldRef<TDoc> | FieldName<TDoc> | null | Document>;

type DollarField<TDoc, V> = V extends `$${infer F}`
  ? F extends FieldName<TDoc>
    ? TDoc[F & keyof TDoc]
    : unknown
  : V extends Document
    ? unknown
    : V;

/** Resolved type of a `$group` accumulator expression. */
export type AccumulatorResult<TDoc, A> = A extends { $sum: unknown }
  ? number
  : A extends { $avg: unknown }
    ? number
    : A extends { $count: unknown }
      ? number
      : A extends { $first: infer V }
        ? DollarField<TDoc, V>
        : A extends { $last: infer V }
          ? DollarField<TDoc, V>
          : A extends { $max: infer V }
            ? DollarField<TDoc, V>
            : A extends { $min: infer V }
              ? DollarField<TDoc, V>
              : A extends { $push: infer V }
                ? DollarField<TDoc, V>[]
                : A extends { $addToSet: infer V }
                  ? DollarField<TDoc, V>[]
                  : unknown;

/** Output document of a `$group`: `_id` + one field per accumulator. */
export type Grouped<TDoc, G extends GroupSpec<TDoc>> = {
  _id: G["_id"] extends FieldRef<TDoc>
    ? DollarField<TDoc, G["_id"]>
    : G["_id"] extends FieldName<TDoc>
      ? G["_id"] extends keyof TDoc
        ? TDoc[G["_id"]]
        : unknown
      : G["_id"] extends null
        ? null
        : unknown;
} & { [K in Exclude<keyof G, "_id">]: AccumulatorResult<TDoc, G[K]> };

/** `$unwind` argument (string path or object form). */
export type UnwindSpec =
  | string
  | { path: string; includeArrayIndex?: string; preserveNullAndEmptyArrays?: boolean };

type UnwindScalar<TDoc, F extends string> = F extends keyof TDoc
  ? TDoc[F] extends readonly (infer E)[]
    ? E
    : TDoc[F]
  : unknown;

/** Output of `$unwind`: the unwound array field becomes its element type. */
export type Unwound<TDoc, P extends UnwindSpec> = P extends string
  ? P extends `$${infer F}`
    ? TDoc & { [K in F]: UnwindScalar<TDoc, F> }
    : TDoc
  : P extends { path: `$${infer F}`; preserveNullAndEmptyArrays: true }
    ? TDoc & { [K in F]: UnwindScalar<TDoc, F> | null }
    : P extends { path: `$${infer F}` }
      ? TDoc & { [K in F]: UnwindScalar<TDoc, F> }
      : TDoc;

/** Foreign collection's document type for a `$lookup.from`. */
export type ForeignDocOf<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C,
> =
  C extends ExtractCollectionNames<TClients, TDb> ? ExtractCollectionType<TClients, TDb, C> : never;

/**
 * `$lookup` spec keyed by a concrete foreign collection `F`. `from` is
 * validated as a known collection, `localField` a field on the source doc,
 * `foreignField` a field on the foreign doc.
 *
 * `F` is inferred from `from` as its own type parameter so the sub-pipeline
 * callback can be contextually typed against the foreign doc without depending
 * on the (not-yet-inferred) whole spec — this avoids the implicit-`any` pitfall
 * of an `S & Valid<..., S>` intersection.
 */
export type LookupSpecFor<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  TDoc extends Document,
  F extends ExtractCollectionNames<TClients, TDb>,
> = {
  from: F;
  localField: FieldName<TDoc>;
  foreignField?: FieldName<ForeignDocOf<TClients, TDb, F>>;
  as: string;
  let?: Record<string, unknown>;
};

/** Source doc joined with the `$lookup` output under its `as` field. */
export type LookupJoinedFor<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  TDoc extends Document,
  F extends ExtractCollectionNames<TClients, TDb>,
  A extends string,
  O extends Document = ForeignDocOf<TClients, TDb, F>,
> = TDoc & { [K in A]: O[] };

/**
 * `$facet` spec: each named branch is a raw pipeline or a function receiving a
 * builder scoped to the current doc.
 */
export type FacetSpec<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  TDoc extends Document,
> = Record<
  string,
  | Document[]
  | ((
      sub: PipelineBuilder<TClients, TDb, TDoc>,
    ) => PipelineBuilder<TClients, TDb, any> | Document[])
>;

/** Output of `$facet`: one array per branch, typed when built with a builder. */
export type FacetOutput<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  TDoc extends Document,
  F extends FacetSpec<TClients, TDb, TDoc>,
> = {
  [K in keyof F]: F[K] extends (s: any) => infer R
    ? R extends PipelineBuilder<any, any, infer O>
      ? O[]
      : unknown[]
    : unknown[];
};

/** Backward-compatible runtime shape for the callback `aggregate().lookup(...)`. */
export interface LookupParams<TDoc extends Document = Document> {
  from: string;
  localField: FieldName<TDoc> | string;
  foreignField: string;
  as: string;
  pipeline?: Document[];
  let?: Record<string, unknown>;
}

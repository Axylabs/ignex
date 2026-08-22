/**
 * Relation definitions used by `populate`. Relations declare how documents in
 * one collection reference documents in another; `populate` then resolves them
 * with DataLoader-batched `$in` queries (1 + N queries total, not 1 + N×M).
 */
import type { Document } from "mongodb";
import type { RemoveIndexSignature } from "../shared/types.ts";
import type {
  DbClientsDefinition,
  ExtractCollectionNames,
  ExtractCollectionType,
  ExtractDbNames,
} from "../types.ts";

export interface RelationDefBase {
  /** Foreign logical collection. */
  collection: string;
  /** Field on the source document holding the reference key(s). */
  localField: string;
  /** Field on the foreign document to match (default `_id`). */
  foreignField?: string;
  /** Field name attached to the source document after population. */
  as: string;
  /** Optional: max keys per batched `$in` query. */
  maxBatchSize?: number;
  /** Optional: cache resolved relations on the loader (default true). */
  cache?: boolean;
  /** When true, a missing belongsTo target attaches `undefined` instead of `null`. */
  optional?: boolean;
}

export interface BelongsToRelation extends RelationDefBase {
  type: "belongsTo";
}

export interface HasManyRelation extends RelationDefBase {
  type: "hasMany";
}

export interface ManyToManyRelation extends RelationDefBase {
  type: "manyToMany";
  through: {
    /** Join collection (logical). */
    collection: string;
    /** Field on the join doc pointing at the source doc. */
    localField: string;
    /** Field on the join doc pointing at the target doc. */
    foreignField: string;
  };
}

export type RelationDef = BelongsToRelation | HasManyRelation | ManyToManyRelation;

/* ------------------------------------------------------------------ *
 * Schema-validated relation types. `populate` constrains each relation
 * against the schema registry: `collection` must be a known collection,
 * `localField` a field on the source doc, `foreignField` a field on the
 * target doc, and `through.*` fields on the join doc.
 * ------------------------------------------------------------------ */

type RelColNames<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
> = ExtractCollectionNames<TClients, TDb>;

type RelDocOf<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  C extends RelColNames<TClients, TDb>,
> = ExtractCollectionType<TClients, TDb, C>;

/** Field-name union of a doc, excluding Mongo `Document`'s index-signature keys. */
type RelField<T> = Extract<keyof RemoveIndexSignature<T>, string>;

/** Validates one relation object `R` against the source doc and the registry. */
export type ValidRelation<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  TSource extends Document,
  R,
> = R extends { type: "belongsTo"; collection: infer C }
  ? C extends RelColNames<TClients, TDb>
    ? Omit<R, "localField" | "foreignField"> & {
        localField: RelField<TSource>;
        foreignField?: RelField<RelDocOf<TClients, TDb, C>>;
      }
    : never
  : R extends { type: "hasMany"; collection: infer C }
    ? C extends RelColNames<TClients, TDb>
      ? Omit<R, "localField" | "foreignField"> & {
          localField: RelField<TSource>;
          foreignField?: RelField<RelDocOf<TClients, TDb, C>>;
        }
      : never
    : R extends {
          type: "manyToMany";
          collection: infer C;
          through: { collection: infer TC };
        }
      ? C extends RelColNames<TClients, TDb>
        ? TC extends RelColNames<TClients, TDb>
          ? Omit<R, "localField" | "foreignField" | "through"> & {
              localField: RelField<TSource>;
              foreignField?: RelField<RelDocOf<TClients, TDb, C>>;
              through: {
                collection: TC;
                localField: RelField<RelDocOf<TClients, TDb, TC>>;
                foreignField: RelField<RelDocOf<TClients, TDb, TC>>;
              };
            }
          : never
        : never
      : never;

/**
 * Maps a tuple of relations to the joined `as` fields attached to result docs.
 * `belongsTo` resolves to `Doc | null`; `hasMany` / `manyToMany` to `Doc[]`.
 */
export type JoinedFields<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  R extends readonly unknown[],
> = {
  [K in keyof R as K extends `${number}`
    ? R[K] extends { as: infer A extends string }
      ? A
      : never
    : never]: R[K] extends { type: "belongsTo"; collection: infer C }
    ? C extends RelColNames<TClients, TDb>
      ? RelDocOf<TClients, TDb, C> | null
      : never
    : R[K] extends { type: "hasMany" | "manyToMany"; collection: infer C }
      ? C extends RelColNames<TClients, TDb>
        ? RelDocOf<TClients, TDb, C>[]
        : never
      : never;
};

type BelongsToConfig<C extends string, A extends string, L extends string, F extends string> = Omit<
  BelongsToRelation,
  "type" | "collection" | "as" | "localField" | "foreignField"
> & {
  collection: C;
  as: A;
  localField: L;
  foreignField?: F;
};

type HasManyConfig<C extends string, A extends string, L extends string, F extends string> = Omit<
  HasManyRelation,
  "type" | "collection" | "as" | "localField" | "foreignField"
> & {
  collection: C;
  as: A;
  localField: L;
  foreignField?: F;
};

type ManyToManyConfig<
  C extends string,
  A extends string,
  L extends string,
  TC extends string,
  F extends string,
  TLoc extends string,
  TFor extends string,
> = Omit<
  ManyToManyRelation,
  "type" | "collection" | "as" | "localField" | "foreignField" | "through"
> & {
  collection: C;
  as: A;
  localField: L;
  foreignField?: F;
  through: {
    collection: TC;
    localField: TLoc;
    foreignField: TFor;
  };
};

/** One source doc → at most one foreign doc (defaults `foreignField: '_id'`). */
export const belongsTo = <
  const C extends string,
  const A extends string,
  const L extends string,
  const F extends string = "_id",
>(
  config: BelongsToConfig<C, A, L, F>,
): BelongsToRelation & { collection: C; as: A; localField: L; foreignField: F } =>
  ({
    type: "belongsTo",
    foreignField: "_id",
    ...config,
  }) as BelongsToRelation & { collection: C; as: A; localField: L; foreignField: F };

/** One source doc → many foreign docs (defaults `foreignField: '_id'`). */
export const hasMany = <
  const C extends string,
  const A extends string,
  const L extends string,
  const F extends string = "_id",
>(
  config: HasManyConfig<C, A, L, F>,
): HasManyRelation & { collection: C; as: A; localField: L; foreignField: F } =>
  ({
    type: "hasMany",
    foreignField: "_id",
    ...config,
  }) as HasManyRelation & { collection: C; as: A; localField: L; foreignField: F };

/** Source doc → join docs → target docs through a pivot collection. */
export const manyToMany = <
  const C extends string,
  const A extends string,
  const L extends string,
  const TC extends string,
  const F extends string = "_id",
  const TLoc extends string = "_id",
  const TFor extends string = "_id",
>(
  config: ManyToManyConfig<C, A, L, TC, F, TLoc, TFor>,
): ManyToManyRelation & {
  collection: C;
  as: A;
  localField: L;
  foreignField: F;
  through: { collection: TC; localField: TLoc; foreignField: TFor };
} =>
  ({
    type: "manyToMany",
    foreignField: "_id",
    ...config,
  }) as ManyToManyRelation & {
    collection: C;
    as: A;
    localField: L;
    foreignField: F;
    through: { collection: TC; localField: TLoc; foreignField: TFor };
  };

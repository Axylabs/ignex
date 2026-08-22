/**
 * Strict, schema-aware update payloads.
 *
 * The MongoDB driver's own `UpdateFilter<T>` is intentionally loose — every
 * operator is intersected with `Record<string, any>`, so unknown keys and
 * wrong value types all type-check. These types re-derive each `$` operator
 * against the document type instead: keys are restricted to schema fields,
 * `$inc`/`$mul`/`$bit` to numeric fields, `$push`/`$addToSet`/`$pull`/`$pullAll`/
 * `$pop` to array fields, and `$currentDate` to date fields. The driver accepts
 * a superset of these payloads, so the tight type is passed through with a
 * plain cast at the driver boundary.
 */

/** Fields of `T` whose value is numeric (usable with `$inc`, `$mul`, `$bit`). */
export type NumericFields<T> = {
  [K in keyof T as T[K] extends number ? K : never]?: number;
};

/** Fields of `T` whose value is a `Date` (usable with `$currentDate`). */
export type DateFields<T> = {
  [K in keyof T as T[K] extends Date ? K : never]?: true | { $type: "date" | "timestamp" };
};

/** Value accepted by `$push` for an array of `I`. */
export type PushValue<I> =
  | I
  | {
      $each: readonly I[];
      $position?: number;
      $slice?: number;
      $sort?: 1 | -1 | Record<string, 1 | -1>;
    };

/** Value accepted by `$addToSet` for an array of `I`. */
export type AddToSetValue<I> = I | { $each: readonly I[] };

/** Value accepted by `$pull` for an array of `I`. */
export type PullValue<I> = I | { $in: readonly I[] };

/** Array fields of `T` mapped to a per-op value type derived from the item type. */
export type PushFields<T> = {
  [K in keyof T as T[K] extends readonly unknown[] ? K : never]?: T[K] extends readonly (infer I)[]
    ? PushValue<I>
    : never;
};

export type AddToSetFields<T> = {
  [K in keyof T as T[K] extends readonly unknown[] ? K : never]?: T[K] extends readonly (infer I)[]
    ? AddToSetValue<I>
    : never;
};

export type PullFields<T> = {
  [K in keyof T as T[K] extends readonly unknown[] ? K : never]?: T[K] extends readonly (infer I)[]
    ? PullValue<I>
    : never;
};

export type PullAllFields<T> = {
  [K in keyof T as T[K] extends readonly unknown[] ? K : never]?: T[K] extends readonly (infer I)[]
    ? readonly I[]
    : never;
};

export type PopFields<T> = {
  [K in keyof T as T[K] extends readonly unknown[] ? K : never]?: 1 | -1;
};

/** The `$`-operator form of an update, keyed strictly against the document type. */
export type UpdateOperators<T> = {
  $set?: Partial<T>;
  $setOnInsert?: Partial<T>;
  $unset?: Partial<Record<keyof T, "" | true | 1>>;
  $inc?: NumericFields<T>;
  $mul?: NumericFields<T>;
  $min?: Partial<T>;
  $max?: Partial<T>;
  $bit?: NumericFields<T>;
  $currentDate?: DateFields<T>;
  $push?: PushFields<T>;
  $addToSet?: AddToSetFields<T>;
  $pull?: PullFields<T>;
  $pullAll?: PullAllFields<T>;
  $pop?: PopFields<T>;
  $rename?: Partial<Record<keyof T, keyof T>>;
};

/**
 * Update payload accepted by the ORM's update methods: either a plain field
 * patch (automatically wrapped in `$set` by `formatUpdateFilter`) or
 * `$`-operator syntax. Keys and values are checked against the document schema.
 *
 * The doc type is precise (schema-derived), so unknown keys are rejected in
 * fresh object literals via excess-property checking AND in non-literal patches
 * (the inferred type has no index signature to absorb them). The only way an
 * unknown key passes is a variable explicitly typed with an index signature
 * (e.g. `Record<string, any>`) — an intentional "unknown shape" escape hatch;
 * prefer inline literals for full checking.
 */
export type UpdateInput<T> = Partial<T> | UpdateOperators<T>;

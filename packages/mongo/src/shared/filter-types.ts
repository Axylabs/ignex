/**
 * Strict, schema-aware query filter.
 *
 * The driver's own `Filter<T>` is deliberately loose: its `RootFilterOperators`
 * extends `Document` (`{ [key: string]: any }`), so `Filter<PreciseDoc>` still
 * accepts ANY top-level key. This type re-declares the field-level portion of
 * the filter plus the root operators WITHOUT inheriting that index signature,
 * so a typo'd or undeclared field is a compile error on object literals.
 *
 * It is a strict subset of the driver's `Filter<T>`, so the ORM bridges it with
 * a cast only at the driver boundary.
 */
import type { Condition, RootFilterOperators, WithId } from "mongodb";

/** Field-level portion of a filter: exact match, `$`-operators, or nested. */
type FieldFilters<T> = {
  [P in keyof WithId<T>]?: Condition<WithId<T>[P]>;
};

/** Root operators, mirroring the driver's `RootFilterOperators` without `Document`'s index signature. */
type RootOperators<T> = {
  $and?: FilterInput<T>[];
  $nor?: FilterInput<T>[];
  $or?: FilterInput<T>[];
  $text?: RootFilterOperators<T>["$text"];
  $where?: RootFilterOperators<T>["$where"];
  $comment?: RootFilterOperators<T>["$comment"];
};

export type FilterInput<T> = FieldFilters<T> & RootOperators<T>;

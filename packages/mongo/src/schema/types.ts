/**
 * Typed schema DSL for `ninox`.
 *
 * Schemas are plain, serializable objects (kind + constraints + flags). They
 * serve three purposes at once:
 *   1. Derive the TypeScript document type (`InferDoc<T>`)
 *   2. Drive the fluent query builder's field typing
 *   3. Convert to a MongoDB `$jsonSchema` validator (`toMongoValidator`)
 *
 * Example:
 *   const userSchema = s.object({
 *     _id: s.objectId(),
 *     email: s.string().optional(),
 *     age: s.integer({ minimum: 0 }),
 *     role: s.enum(['admin', 'user'] as const),
 *     createdAt: s.date(),
 *   });
 *   type User = InferDoc<typeof userSchema>;
 */
import type { MongoJsonSchema } from "./json-schema.ts";

export interface FieldFlags {
  optional: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
}

export interface FieldMeta {
  kind: string;
  flags: FieldFlags;
  description?: string;
}

export interface StringField extends FieldMeta {
  kind: "string";
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface IntegerField extends FieldMeta {
  kind: "number";
  integer: true;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  /** Draft-4 boolean form: `minimum` is excluded from the allowed range. */
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
}

export interface NumberField extends FieldMeta {
  kind: "number";
  integer?: false;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
}

/** Strict BSON `double` (IEEE 754 float64) field. */
export interface DoubleField extends FieldMeta {
  kind: "double";
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
}

/** Strict BSON `long` (int64) field — inferred as `number` (precision caveat). */
export interface LongField extends FieldMeta {
  kind: "long";
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
}

/** Strict BSON `decimal` (Decimal128) field — inferred as `Decimal128`. */
export interface DecimalField extends FieldMeta {
  kind: "decimal";
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
}

export interface BooleanField extends FieldMeta {
  kind: "boolean";
}

export interface DateField extends FieldMeta {
  kind: "date";
}

export interface ObjectIdField extends FieldMeta {
  kind: "objectId";
}

export interface ArrayField<I extends SchemaType = SchemaType> extends FieldMeta {
  kind: "array";
  items: I;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface ObjectField<
  P extends Record<string, SchemaType> = Record<string, SchemaType>,
  N extends string = string,
> extends FieldMeta {
  kind: "object";
  properties: P;
  additionalProperties?: boolean;
  minProperties?: number;
  maxProperties?: number;
  /**
   * Optional collection name carried by the schema. When present, the schema is
   * the single source of truth for the collection name — `defineCollections`
   * keys the derived `collections` map by it.
   */
  name?: N;
}

export interface EnumField<V extends readonly (string | number)[] = readonly (string | number)[]>
  extends FieldMeta {
  kind: "enum";
  values: V;
}

export interface AnyField extends FieldMeta {
  kind: "any";
}

export interface NullField extends FieldMeta {
  kind: "null";
}

export interface GeoPointField extends FieldMeta {
  kind: "geoPoint";
}

export interface RawField extends FieldMeta {
  kind: "raw";
  /** Arbitrary `$jsonSchema` fragment passed through verbatim (escape hatch). */
  fragment: MongoJsonSchema;
}

export type SchemaType =
  | StringField
  | IntegerField
  | NumberField
  | DoubleField
  | LongField
  | DecimalField
  | BooleanField
  | DateField
  | ObjectIdField
  | ArrayField
  | ObjectField
  | EnumField
  | AnyField
  | NullField
  | GeoPointField
  | RawField;

/** A schema with chainable `.optional()` / `.default()` modifiers attached. */
export type Chainable<T extends SchemaType> = T & {
  optional(): Chainable<T & { flags: { optional: true } }>;
  default(value: unknown): Chainable<T & { flags: { hasDefault: true; defaultValue: unknown } }>;
};

const chain = <T extends SchemaType>(field: T): Chainable<T> => {
  const obj = field as unknown as Chainable<T>;
  obj.optional = () => chain({ ...field, flags: { ...field.flags, optional: true } });
  obj.default = (value: unknown) =>
    chain({ ...field, flags: { ...field.flags, hasDefault: true, defaultValue: value } });
  return obj;
};

const BASE = { flags: { optional: false, hasDefault: false } } as const;

/**
 * Object schema factory (exposed as `s.object`). When `name` is provided the
 * returned schema carries it as a required literal, so `defineCollections` can
 * key the derived map by it and forget a name becomes a type error.
 */
function objectField<P extends Record<string, SchemaType>, N extends string>(
  properties: P,
  opts: {
    additionalProperties?: boolean;
    minProperties?: number;
    maxProperties?: number;
    name: N;
  },
): Chainable<ObjectField<P, N> & { name: N }>;
function objectField<P extends Record<string, SchemaType>>(
  properties: P,
  opts?: { additionalProperties?: boolean; minProperties?: number; maxProperties?: number },
): Chainable<ObjectField<P, string>>;
function objectField<P extends Record<string, SchemaType>, N extends string = string>(
  properties: P,
  opts: {
    additionalProperties?: boolean;
    minProperties?: number;
    maxProperties?: number;
    name?: N;
  } = {},
): Chainable<ObjectField<P, N> & { name?: N }> {
  return chain({ kind: "object", properties, ...BASE, ...opts });
}

/** Numeric constraints shared by every numeric field kind. */
export type NumberBounds = {
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
};

export const s = {
  /** UTF-8 string field (optional `format` / length / regex constraints). */
  string(
    opts: { format?: string; minLength?: number; maxLength?: number; pattern?: string } = {},
  ): Chainable<StringField> {
    return chain({ kind: "string", ...BASE, ...opts });
  },
  /** 32-bit integer field with optional bounds (min/max, exclusive, multipleOf). */
  integer(opts: NumberBounds = {}): Chainable<IntegerField> {
    return chain({ kind: "number", integer: true, ...BASE, ...opts });
  },
  /** Double/float field with optional bounds (min/max, exclusive, multipleOf). */
  number(opts: NumberBounds = {}): Chainable<NumberField> {
    return chain({ kind: "number", integer: false, ...BASE, ...opts });
  },
  /** Strict BSON `double` (IEEE 754 float64) field. */
  double(opts: NumberBounds = {}): Chainable<DoubleField> {
    return chain({ kind: "double", ...BASE, ...opts });
  },
  /** Strict BSON `long` (int64) field — inferred as `number`. */
  long(opts: NumberBounds = {}): Chainable<LongField> {
    return chain({ kind: "long", ...BASE, ...opts });
  },
  /** Strict BSON `decimal` (Decimal128) field — inferred as `Decimal128`. */
  decimal(opts: NumberBounds = {}): Chainable<DecimalField> {
    return chain({ kind: "decimal", ...BASE, ...opts });
  },
  /** Boolean field. */
  boolean(): Chainable<BooleanField> {
    return chain({ kind: "boolean", ...BASE });
  },
  /** UTC datetime field (BSON date). */
  date(): Chainable<DateField> {
    return chain({ kind: "date", ...BASE });
  },
  /** MongoDB ObjectId field (`_id` and foreign keys). */
  objectId(): Chainable<ObjectIdField> {
    return chain({ kind: "objectId", ...BASE });
  },
  /** Array of `items` (nested schema types allowed), with optional length/uniqueness. */
  array<I extends SchemaType>(
    items: I,
    opts: { minItems?: number; maxItems?: number; uniqueItems?: boolean } = {},
  ): Chainable<ArrayField<I>> {
    const field: ArrayField<I> = { kind: "array", items, ...BASE, ...opts };
    return chain(field);
  },
  object: objectField,
  /** Enum union of literal string/number values. */
  enum<V extends readonly (string | number)[]>(values: V): Chainable<EnumField<V>> {
    const field: EnumField<V> = { kind: "enum", values, ...BASE };
    return chain(field);
  },
  /** Unconstrained field (no validator bounds). */
  any(): Chainable<AnyField> {
    return chain({ kind: "any", ...BASE });
  },
  /** Explicitly-nullable field. */
  null(): Chainable<NullField> {
    return chain({ kind: "null", ...BASE });
  },
  /** GeoJSON Point field (type `Point` + `[lng, lat]` coordinates) for `2dsphere` queries. */
  geoPoint(): Chainable<GeoPointField> {
    return chain({ kind: "geoPoint", ...BASE });
  },
  /**
   * Raw `$jsonSchema` escape hatch: pass an arbitrary fragment through verbatim
   * to the validator. Use for Mongo keywords the DSL doesn't model (e.g.
   * `patternProperties`, `allOf`, `anyOf`, `dependencies`).
   */
  jsonSchema(fragment: MongoJsonSchema): Chainable<RawField> {
    return chain({ kind: "raw", fragment, ...BASE });
  },
};

/** Standalone modifier: mark a field as optional (`s.string().optional()` equivalent). */
export const optional = <T extends SchemaType>(
  field: T,
): Chainable<T & { flags: { optional: true } }> =>
  chain({ ...field, flags: { ...field.flags, optional: true } });

/** Standalone modifier: attach a default value. */
export const withDefault = <T extends SchemaType>(
  field: T,
  value: unknown,
): Chainable<T & { flags: { hasDefault: true; defaultValue: unknown } }> =>
  chain({ ...field, flags: { ...field.flags, hasDefault: true, defaultValue: value } });

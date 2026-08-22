/**
 * The `$jsonSchema` fragment type emitted by the ORM's schema DSL.
 *
 * Kept in its own module (no imports) so both the DSL (`types.ts`) and the
 * converter (`to-mongo-schema.ts`) can reference it without a circular import
 * — the DSL's `s.jsonSchema(fragment)` escape hatch needs the type, and the
 * converter produces it.
 *
 * Mirrors the MongoDB `$jsonSchema` keywords this ORM supports (plus a few it
 * accepts verbatim via the raw escape hatch). Unknown/unlisted keywords are not
 * enforced at the type level, so a raw fragment can still be passed through
 * `as MongoJsonSchema` when needed.
 */
export interface MongoJsonSchema {
  /** A single BSON type, or an array of allowed types (e.g. ['date', 'null']). */
  bsonType?: string | string[];
  required?: string[];
  properties?: Record<string, MongoJsonSchema>;
  additionalProperties?: boolean | MongoJsonSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  /** Draft-4 boolean form, or numeric form on newer servers. */
  exclusiveMinimum?: boolean | number;
  exclusiveMaximum?: boolean | number;
  multipleOf?: number;
  enum?: unknown[];
  items?: MongoJsonSchema | MongoJsonSchema[];
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  description?: string;
}

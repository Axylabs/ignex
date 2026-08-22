import type { MongoJsonSchema } from "./json-schema.ts";
import type { ObjectField, SchemaType } from "./types.ts";

export type { MongoJsonSchema } from "./json-schema.ts";

/**
 * Schema → MongoDB `$jsonSchema` validator conversion. This is the ORM's
 * headline feature: one schema definition drives TS types AND server-side
 * document validation + collection creation.
 *
 * Mapping (mirrors sdk-db `convertJsonSchemaToMongoSchema`):
 *   string→string, integer→int, number→number, double→double, long→long,
 *   decimal→decimal, boolean→bool, date→date, objectId→objectId,
 *   array→array(items), object→object(properties/required),
 *   enum→enum (+bsonType), null→null, any→no constraint, raw→fragment verbatim.
 *   The top-level `_id` is forced to `objectId` regardless of declared type.
 */

/** Copy numeric keywords (min/max/exclusive/multipleOf) onto a fragment. */
const addNumericBounds = (
  out: MongoJsonSchema,
  field: {
    minimum?: number;
    maximum?: number;
    multipleOf?: number;
    exclusiveMinimum?: boolean;
    exclusiveMaximum?: boolean;
  },
): MongoJsonSchema => {
  if (field.minimum !== undefined) out.minimum = field.minimum;
  if (field.maximum !== undefined) out.maximum = field.maximum;
  if (field.multipleOf !== undefined) out.multipleOf = field.multipleOf;
  if (field.exclusiveMinimum) out.exclusiveMinimum = true;
  if (field.exclusiveMaximum) out.exclusiveMaximum = true;
  return out;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: schema-kind conversion is inherently branchy
const convertField = (field: SchemaType): MongoJsonSchema => {
  // Raw escape hatch: pass the fragment through verbatim. A `description` on
  // the DSL field is merged only when the fragment doesn't already carry one.
  if (field.kind === "raw") {
    const out = { ...field.fragment };
    if (field.description && !out.description) out.description = field.description;
    return out;
  }

  const out: MongoJsonSchema = {};
  if (field.description) out.description = field.description;

  switch (field.kind) {
    case "string":
      out.bsonType = "string";
      if (field.minLength !== undefined) out.minLength = field.minLength;
      if (field.maxLength !== undefined) out.maxLength = field.maxLength;
      if (field.pattern) out.pattern = field.pattern;
      // `format` is intentionally NOT emitted: MongoDB's `$jsonSchema` rejects the
      // keyword with `$jsonSchema keyword 'format' is not currently supported`, so
      // emitting it would make `createCollection`/`collMod` fail server-side. The
      // DSL option remains accepted for authoring intent, but it is a no-op here.
      return out;
    case "number":
      out.bsonType = field.integer ? "int" : "number";
      return addNumericBounds(out, field);
    case "double":
      out.bsonType = "double";
      return addNumericBounds(out, field);
    case "long":
      out.bsonType = "long";
      return addNumericBounds(out, field);
    case "decimal":
      out.bsonType = "decimal";
      return addNumericBounds(out, field);
    case "boolean":
      out.bsonType = "bool";
      return out;
    case "date":
      out.bsonType = "date";
      return out;
    case "objectId":
      out.bsonType = "objectId";
      return out;
    case "geoPoint":
      return {
        bsonType: "object",
        required: ["type", "coordinates"],
        properties: {
          type: { enum: ["Point"] },
          coordinates: {
            bsonType: "array",
            items: { bsonType: "number" },
            minItems: 2,
            maxItems: 2,
          },
        },
      };
    case "null":
      out.bsonType = "null";
      return out;
    case "any":
      return out;
    case "enum": {
      out.enum = [...field.values];
      // `bsonType` and `enum` are AND-ed by Mongo's `$jsonSchema`. The old
      // behavior picked ONE bsonType from the first non-null member, which
      // silently excluded members of other types server-side (a mixed enum
      // like `s.enum(['a', 1])` only ever accepted strings). Emit the union
      // of every member's type so the enum set is the sole constraint:
      //   ['a', 1]    → bsonType ['string', 'int']
      //   ['x', null] → bsonType ['string', 'null']
      //   [1, 2, 3]   → bsonType 'int' (unchanged)
      //   [1, 2.5]    → bsonType 'number' (matches every numeric BSON type)
      //   [null]      → bsonType 'null'
      const types = new Set<string>();
      for (const v of field.values) {
        if (v === null) types.add("null");
        else if (typeof v === "string") types.add("string");
        else if (typeof v === "number") {
          const allInt = field.values.every((x) => typeof x !== "number" || Number.isInteger(x));
          types.add(allInt ? "int" : "number");
          break; // 'int'/'number' already covers every numeric member
        }
      }
      if (types.size === 1) {
        out.bsonType = [...types][0]!;
      } else if (types.size > 1) {
        out.bsonType = [...types];
      }
      return out;
    }
    case "array":
      out.bsonType = "array";
      out.items = convertField(field.items);
      if (field.minItems !== undefined) out.minItems = field.minItems;
      if (field.maxItems !== undefined) out.maxItems = field.maxItems;
      if (field.uniqueItems) out.uniqueItems = true;
      return out;
    case "object":
      return convertObject(field);
  }
};

const convertObject = (field: ObjectField): MongoJsonSchema => {
  const out: MongoJsonSchema = { bsonType: "object" };
  const required: string[] = [];
  const properties: Record<string, MongoJsonSchema> = {};

  for (const [key, prop] of Object.entries(field.properties)) {
    properties[key] = convertField(prop);
    if (!prop.flags.optional && !prop.flags.hasDefault) required.push(key);
  }

  if (required.length > 0) out.required = required;
  out.properties = properties;
  // Strict by default: the DB `$jsonSchema` validator is the ONLY runtime
  // validation layer (per project decision — no client-side schema validation),
  // so unknown fields are rejected unless a field explicitly opts out
  // (`additionalProperties: true`).
  out.additionalProperties = field.additionalProperties ?? false;
  if (field.minProperties !== undefined) out.minProperties = field.minProperties;
  if (field.maxProperties !== undefined) out.maxProperties = field.maxProperties;
  return out;
};

/**
 * ORM-managed lifecycle fields the library itself writes, reserved in the
 * validator so strict validation (`additionalProperties: false`) doesn't
 * reject them — the same treatment `_id` already gets:
 *   `__v`       — optimistic-lock version counter (`updateWithVersion`)
 *   `deletedAt` — soft-delete marker (`softDeleteOne`); `null` means active
 * Only injected when the schema does NOT already declare the field. Exported
 * so the runtime drift validator (`validate-doc.ts`) stays in sync.
 */
export const ORM_RESERVED_FIELDS: Record<string, MongoJsonSchema> = {
  __v: { bsonType: "int" },
  deletedAt: { bsonType: ["date", "null"] },
};

/** Convert an object schema into a Mongo JSON-schema fragment (no `$jsonSchema` wrapper). */
export const toMongoSchema = (schema: ObjectField): MongoJsonSchema => {
  const result = convertObject(schema);
  result.properties ??= {};
  // Only inject `_id` when the schema does NOT declare it. MongoDB's default is
  // ObjectId, and because validation is strict by default the implicit `_id`
  // must be a declared property or every insert is rejected by the DB validator.
  // A user-declared `_id` is respected as-is (e.g. `s.string()` for string ids),
  // so the inferred TS type (InferDoc) and the DB validator stay in agreement.
  if (!result.properties._id) {
    result.properties._id = { bsonType: "objectId" };
  }
  // Reserve the ORM's own lifecycle fields so soft-delete and optimistic
  // locking keep working under strict validation.
  for (const [key, fragment] of Object.entries(ORM_RESERVED_FIELDS)) {
    if (!result.properties[key]) result.properties[key] = fragment;
  }
  return result;
};

/** Full validator object ready for `createCollection({ validator })` / `collMod`. */
export const toMongoValidator = (schema: ObjectField): { $jsonSchema: MongoJsonSchema } => ({
  $jsonSchema: toMongoSchema(schema),
});

/**
 * Drift-validation orchestrator: `validateValue` (dispatch to the per-kind
 * registry), `validateObjectProps` (declared properties + strict unknown-key
 * handling), and the public `validateDoc` entry point.
 *
 * Recursion between `validateValue` and `validateObjectProps` flows through the
 * `deps` object so neither this module nor `./field-validators.ts` imports the
 * other (no cycle).
 */
import type { Document } from "mongodb";
import { ObjectId } from "mongodb";
import { ORM_RESERVED_FIELDS } from "../to-mongo-schema.ts";
import type { ObjectField, SchemaType } from "../types.ts";
import { FIELD_VALIDATORS, type FieldValidatorDeps } from "./field-validators.ts";
import { checkReservedValue, describeValue, push } from "./helpers.ts";
import type { DriftIssue } from "./types.ts";

/** Validate a single value against its field schema, dispatching per kind. */
function validateValue(
  field: SchemaType,
  value: unknown,
  path: string,
  issues: DriftIssue[],
): void {
  const validator = FIELD_VALIDATORS[field.kind];
  if (validator) validator(deps, field, value, path, issues);
}

/** Validate an object's declared properties + strict unknown-key handling. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recursive validator is inherently branchy
function validateObjectProps(
  field: ObjectField,
  value: Document,
  path: string,
  issues: DriftIssue[],
  topLevel: boolean,
): void {
  const propPath = (key: string): string => (path ? `${path}.${key}` : key);

  for (const [key, prop] of Object.entries(field.properties)) {
    const present = key in value && value[key] !== undefined;
    if (!present) {
      if (!prop.flags.optional && !prop.flags.hasDefault) {
        push(issues, propPath(key), "missing", prop.kind, `Required field "${key}" is missing`);
      }
      continue;
    }
    validateValue(prop, value[key], propPath(key), issues);
  }

  // Strict by default: mirror the validator's `additionalProperties: false`
  // unless the field opted out. The top level additionally allows the ORM's
  // reserved lifecycle fields (they are reserved in the $jsonSchema too).
  if (field.additionalProperties !== true) {
    const allowedReserved = topLevel
      ? new Set(["_id", ...Object.keys(ORM_RESERVED_FIELDS)])
      : new Set<string>();
    for (const key of Object.keys(value)) {
      if (key in field.properties) continue;
      if (allowedReserved.has(key)) continue;
      push(
        issues,
        propPath(key),
        "unknown_key",
        "no additional properties",
        `Unexpected field "${key}"`,
      );
    }
  }

  const propCount = Object.keys(value).length;
  if (field.minProperties !== undefined && propCount < field.minProperties) {
    push(
      issues,
      path,
      "constraint",
      `object(minProperties ${field.minProperties})`,
      `Has ${propCount} properties < ${field.minProperties}`,
    );
  }
  if (field.maxProperties !== undefined && propCount > field.maxProperties) {
    push(
      issues,
      path,
      "constraint",
      `object(maxProperties ${field.maxProperties})`,
      `Has ${propCount} properties > ${field.maxProperties}`,
    );
  }

  // Type-check present-but-undeclared reserved lifecycle fields so drift in
  // `_id` / `__v` / `deletedAt` is surfaced too (mirrors toMongoSchema).
  if (topLevel) {
    if ("_id" in value && !("_id" in field.properties) && value._id !== undefined) {
      if (!(value._id instanceof ObjectId)) {
        push(issues, "_id", "type", "ObjectId", 'Reserved field "_id" must be ObjectId');
      }
    }
    for (const key of Object.keys(ORM_RESERVED_FIELDS)) {
      if (key in field.properties) continue;
      if (key in value && value[key] !== undefined) {
        checkReservedValue(key, value[key], key, issues);
      }
    }
  }
}

/** Recursive entry points shared by every validator (built after the functions above). */
const deps: FieldValidatorDeps = { validateValue, validateObjectProps };

/** Check a stored document against the declared schema; returns any drift issues. */
export const validateDoc = (schema: ObjectField, doc: Document): DriftIssue[] => {
  const issues: DriftIssue[] = [];
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    push(issues, "", "type", "object", `Expected a document object, got ${describeValue(doc)}`);
    return issues;
  }
  validateObjectProps(schema, doc, "", issues, true);
  return issues;
};

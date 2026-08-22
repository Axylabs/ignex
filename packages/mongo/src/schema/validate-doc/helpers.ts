/**
 * Shared building blocks for the drift validator: issue recording, value
 * description / BSON-type checks, and numeric-bounds + reserved-field checks.
 * All pure — no schema/doc knowledge, just value-level helpers.
 */
import { Decimal128, ObjectId } from "mongodb";
import { ORM_RESERVED_FIELDS } from "../to-mongo-schema.ts";
import type { DriftIssue, DriftIssueCode } from "./types.ts";

/** Append a drift issue. */
export const push = (
  issues: DriftIssue[],
  path: string,
  code: DriftIssueCode,
  expected: string,
  message: string,
): void => {
  issues.push({ path, code, expected, message });
};

/** Human-readable description of a runtime value (used in type-mismatch messages). */
export const describeValue = (value: unknown): string => {
  if (value instanceof ObjectId) return "ObjectId";
  if (value instanceof Date) return "Date";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

/** Is `value` a plain BSON/JSON object — excludes arrays, dates, ObjectIds, RegExps. */
export const isPlainObject = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof ObjectId) &&
  !(value instanceof RegExp);

/** Coerce a value to a finite number for numeric-constraint checks (Decimal128-aware). */
export const numericValue = (value: unknown): number | undefined => {
  if (value instanceof Decimal128) {
    const n = Number(value.toString());
    return Number.isNaN(n) ? undefined : n;
  }
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  return undefined;
};

/** Shared numeric-bounds shape present on every numeric field kind. */
export interface NumericBounds {
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
}

/** Emit drift issues for numeric bounds shared by every numeric field kind. */
export const checkNumericBounds = (
  field: NumericBounds,
  value: unknown,
  path: string,
  issues: DriftIssue[],
): void => {
  const num = numericValue(value);
  if (num === undefined) return;
  if (
    field.minimum !== undefined &&
    (field.exclusiveMinimum ? num <= field.minimum : num < field.minimum)
  ) {
    push(
      issues,
      path,
      "constraint",
      `minimum ${field.minimum}${field.exclusiveMinimum ? " (exclusive)" : ""}`,
      `${num} out of range`,
    );
  }
  if (
    field.maximum !== undefined &&
    (field.exclusiveMaximum ? num >= field.maximum : num > field.maximum)
  ) {
    push(
      issues,
      path,
      "constraint",
      `maximum ${field.maximum}${field.exclusiveMaximum ? " (exclusive)" : ""}`,
      `${num} out of range`,
    );
  }
  if (field.multipleOf !== undefined && field.multipleOf > 0 && num % field.multipleOf !== 0) {
    push(
      issues,
      path,
      "constraint",
      `multipleOf ${field.multipleOf}`,
      `${num} is not a multiple of ${field.multipleOf}`,
    );
  }
};

/** Does `value` satisfy a single `$jsonSchema` bsonType keyword? */
export const bsonTypeMatches = (bsonType: string | undefined, value: unknown): boolean => {
  switch (bsonType) {
    case "objectId":
      return value instanceof ObjectId;
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "string":
      return typeof value === "string";
    case "bool":
      return typeof value === "boolean";
    case "date":
      return value instanceof Date;
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "double":
      return typeof value === "number" && !Number.isNaN(value);
    case "long":
      return typeof value === "number" && Number.isInteger(value);
    case "decimal":
      return value instanceof Decimal128;
    default:
      return true;
  }
};

/** Validate a value against a `MongoJsonSchema` fragment (used for reserved fields). */
export const checkReservedValue = (
  key: string,
  value: unknown,
  path: string,
  issues: DriftIssue[],
): void => {
  const fragment = (ORM_RESERVED_FIELDS as Record<string, { bsonType?: string | string[] }>)[key];
  if (!fragment) return;
  const types = Array.isArray(fragment.bsonType) ? fragment.bsonType : [fragment.bsonType];
  if (types.some((t) => bsonTypeMatches(t, value))) return;
  push(
    issues,
    path,
    "type",
    types.join(" | "),
    `Reserved field "${key}" must be ${types.join(" | ")}`,
  );
};

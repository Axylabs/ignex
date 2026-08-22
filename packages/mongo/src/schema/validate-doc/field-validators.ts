/**
 * Per-kind drift validators as a lookup table of pure functions — the
 * functional-composition replacement for what was a single giant `switch` over
 * `field.kind` in `validate-doc.ts`.
 *
 * Each validator receives `deps` (the shared recursive entry points
 * `validateValue` / `validateObjectProps`) so array/object kinds can recurse
 * without importing the orchestrator — breaking the import cycle and keeping
 * every field-kind rule small, isolated, and independently readable.
 */
import { Decimal128, type Document, ObjectId } from "mongodb";
import type {
  ArrayField,
  DecimalField,
  DoubleField,
  EnumField,
  LongField,
  NumberField,
  ObjectField,
  SchemaType,
  StringField,
} from "../types.ts";
import { checkNumericBounds, describeValue, isPlainObject, push } from "./helpers.ts";
import type { DriftIssue } from "./types.ts";

/** The recursive entry points the per-kind validators use to descend. */
export interface FieldValidatorDeps {
  validateValue: (field: SchemaType, value: unknown, path: string, issues: DriftIssue[]) => void;
  validateObjectProps: (
    field: ObjectField,
    value: Document,
    path: string,
    issues: DriftIssue[],
    topLevel: boolean,
  ) => void;
}

export type FieldValidator = (
  deps: FieldValidatorDeps,
  field: SchemaType,
  value: unknown,
  path: string,
  issues: DriftIssue[],
) => void;

const stringValidator: FieldValidator = (_deps, field, value, path, issues) => {
  const f = field as StringField;
  if (typeof value !== "string") {
    push(issues, path, "type", "string", `Expected string, got ${describeValue(value)}`);
    return;
  }
  if (f.minLength !== undefined && value.length < f.minLength) {
    push(
      issues,
      path,
      "constraint",
      `string(minLength ${f.minLength})`,
      `Length ${value.length} < ${f.minLength}`,
    );
  }
  if (f.maxLength !== undefined && value.length > f.maxLength) {
    push(
      issues,
      path,
      "constraint",
      `string(maxLength ${f.maxLength})`,
      `Length ${value.length} > ${f.maxLength}`,
    );
  }
  if (f.pattern) {
    try {
      if (!new RegExp(f.pattern).test(value)) {
        push(
          issues,
          path,
          "constraint",
          `string(pattern ${f.pattern})`,
          `"${value}" does not match pattern`,
        );
      }
    } catch {
      // Malformed pattern — nothing to enforce at runtime.
    }
  }
};

const numberValidator: FieldValidator = (_deps, field, value, path, issues) => {
  const f = field as NumberField;
  const expected = f.integer ? "integer" : "number";
  if (typeof value !== "number" || Number.isNaN(value)) {
    push(issues, path, "type", expected, `Expected ${expected}, got ${describeValue(value)}`);
    return;
  }
  if (f.integer && !Number.isInteger(value)) {
    push(issues, path, "type", "integer", `Expected integer, got ${value}`);
  }
  checkNumericBounds(f, value, path, issues);
};

const floatingValidator: FieldValidator = (_deps, field, value, path, issues) => {
  const f = field as DoubleField | LongField | DecimalField;
  const ok =
    f.kind === "decimal"
      ? value instanceof Decimal128
      : f.kind === "long"
        ? typeof value === "number" && Number.isInteger(value)
        : typeof value === "number" && !Number.isNaN(value);
  if (!ok) {
    push(issues, path, "type", f.kind, `Expected ${f.kind}, got ${describeValue(value)}`);
    return;
  }
  checkNumericBounds(f, value, path, issues);
};

const booleanValidator: FieldValidator = (_deps, _field, value, path, issues) => {
  if (typeof value !== "boolean") {
    push(issues, path, "type", "boolean", `Expected boolean, got ${describeValue(value)}`);
  }
};

const dateValidator: FieldValidator = (_deps, _field, value, path, issues) => {
  if (!(value instanceof Date)) {
    push(issues, path, "type", "date", `Expected Date, got ${describeValue(value)}`);
  }
};

const objectIdValidator: FieldValidator = (_deps, _field, value, path, issues) => {
  if (!(value instanceof ObjectId)) {
    push(issues, path, "type", "ObjectId", `Expected ObjectId, got ${describeValue(value)}`);
  }
};

const geoPointValidator: FieldValidator = (_deps, _field, value, path, issues) => {
  if (!isPlainObject(value)) {
    push(issues, path, "type", "GeoPoint", `Expected GeoPoint object, got ${describeValue(value)}`);
    return;
  }
  const gp = value as Document;
  if (gp.type !== "Point") {
    push(
      issues,
      path,
      "enum",
      'GeoPoint(type "Point")',
      `Expected type "Point", got ${JSON.stringify(gp.type)}`,
    );
  }
  const coords = gp.coordinates;
  if (
    !Array.isArray(coords) ||
    coords.length !== 2 ||
    !coords.every((c) => typeof c === "number" && Number.isFinite(c))
  ) {
    push(
      issues,
      path,
      "constraint",
      "GeoPoint(coordinates: [lng, lat])",
      "Expected [lng, lat] pair of finite numbers",
    );
  }
};

const nullValidator: FieldValidator = (_deps, _field, value, path, issues) => {
  if (value !== null) {
    push(issues, path, "type", "null", `Expected null, got ${describeValue(value)}`);
  }
};

const anyValidator: FieldValidator = () => {
  // `any` accepts any value — nothing to check.
};

const rawValidator: FieldValidator = () => {
  // Raw `$jsonSchema` fragments are passed through verbatim and aren't
  // re-checked on the read side (the server enforces them on write).
};

const enumValidator: FieldValidator = (_deps, field, value, path, issues) => {
  const f = field as EnumField;
  if (!f.values.includes(value as never)) {
    push(
      issues,
      path,
      "enum",
      `enum[${f.values.join(", ")}]`,
      `Value ${JSON.stringify(value)} is not in the allowed set`,
    );
  }
};

const arrayValidator: FieldValidator = (deps, field, value, path, issues) => {
  const f = field as ArrayField;
  if (!Array.isArray(value)) {
    push(
      issues,
      path,
      "type",
      `array<${f.items.kind}>`,
      `Expected array, got ${describeValue(value)}`,
    );
    return;
  }
  if (f.minItems !== undefined && value.length < f.minItems) {
    push(
      issues,
      path,
      "constraint",
      `array(minItems ${f.minItems})`,
      `Length ${value.length} < ${f.minItems}`,
    );
  }
  if (f.maxItems !== undefined && value.length > f.maxItems) {
    push(
      issues,
      path,
      "constraint",
      `array(maxItems ${f.maxItems})`,
      `Length ${value.length} > ${f.maxItems}`,
    );
  }
  if (f.uniqueItems) {
    const seen = new Set(
      value.map((item) =>
        item instanceof ObjectId
          ? item.toHexString()
          : typeof item === "object" && item !== null
            ? JSON.stringify(item)
            : item,
      ),
    );
    if (seen.size !== value.length) {
      push(issues, path, "constraint", "array(uniqueItems)", "Array contains duplicate items");
    }
  }
  value.forEach((item, i) => {
    deps.validateValue(f.items, item, `${path}[${i}]`, issues);
  });
};

const objectValidator: FieldValidator = (deps, field, value, path, issues) => {
  const f = field as ObjectField;
  if (!isPlainObject(value)) {
    push(issues, path, "type", "object", `Expected object, got ${describeValue(value)}`);
    return;
  }
  deps.validateObjectProps(f, value as Document, path, issues, false);
};

/** Lookup table: field kind → validator. The single source of per-kind rules. */
export const FIELD_VALIDATORS: Record<SchemaType["kind"], FieldValidator> = {
  string: stringValidator,
  number: numberValidator,
  double: floatingValidator,
  long: floatingValidator,
  decimal: floatingValidator,
  boolean: booleanValidator,
  date: dateValidator,
  objectId: objectIdValidator,
  geoPoint: geoPointValidator,
  null: nullValidator,
  any: anyValidator,
  raw: rawValidator,
  enum: enumValidator,
  array: arrayValidator,
  object: objectValidator,
};

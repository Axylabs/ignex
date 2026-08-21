/**
 * @fileoverview Env-config internal helpers — TypeBox schema introspection and
 * issue collection for {@link env-config}.
 *
 * Pure functions over a flat `Type.Object` schema: property classification
 * (required / optional / default / secret / JSON / boolean), input coercion
 * from a raw `EnvSource`, and the structured `EnvIssue` collectors
 * (missing-required / invalid / missing-optional-warning). Split out of
 * `env-config` so the public validation API stays a thin composition and the
 * schema logic is independently testable.
 */

import type { TObject, TProperties, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { coerceBoolean } from "./coerce";
import { type EnvIssue, EnvIssueCodes, type EnvSource } from "./env-diagnostics";

/** The schema properties of a `TObject`. */
export const properties = (schema: TObject): TProperties => schema.properties;

/** True when the property is a required key of the object schema. */
export const isRequiredKey = (schema: TObject, key: string): boolean =>
  Array.isArray(schema.required) && schema.required.includes(key);

/** True when a property declares a `default` (via schema options). */
export const hasDefault = (prop: TSchema): boolean =>
  (prop as { default?: unknown }).default !== undefined;

/** True when a property is marked secret via `metadata.secret`. */
export const isSecret = (prop: TSchema): boolean => {
  const meta = (prop as { metadata?: { secret?: unknown } }).metadata;
  return meta?.secret === true;
};

/** A short human-readable description of a property's JSON-schema type. */
export const describeType = (prop: TSchema): string => {
  const type = (prop as { type?: unknown }).type;
  if (typeof type === "string") return type;
  const anyOf = (prop as { anyOf?: Array<{ type?: unknown }> }).anyOf;
  if (Array.isArray(anyOf)) {
    const types = anyOf
      .map((entry) => entry.type)
      .filter((t): t is string => typeof t === "string");
    if (types.length > 0) return types.join(" | ");
  }
  return "value";
};

/** Render an offending value for the report (truncated when long). */
export const formatValue = (value: unknown): string => {
  if (value === undefined) return "<unset>";
  const rendered = JSON.stringify(value);
  return rendered.length > 80 ? `${rendered.slice(0, 77)}…` : rendered;
};

/** True when a property's effective JSON-schema type is boolean. */
export const isBooleanProp = (prop: TSchema): boolean =>
  (prop as { type?: unknown }).type === "boolean";

/** True when a property's effective JSON-schema type is array or object. */
export const isJsonProp = (prop: TSchema): boolean => {
  const type = (prop as { type?: unknown }).type;
  return type === "array" || type === "object";
};

/** Attempt to JSON.parse a raw env string; returns `undefined` on failure. */
export const tryJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/** Result of {@link buildInput}. */
export interface BuildInputResult {
  /** Coerced input for keys with a usable value. */
  readonly input: Record<string, unknown>;
  /** Keys whose raw value is a non-empty string that failed JSON.parse. */
  readonly invalidJson: ReadonlyMap<string, string>;
}

/**
 * Build the flat input object from a source, keeping only keys the schema
 * declares that are actually set (absent keys stay absent — typebox 1.x
 * `Convert` turns explicit `undefined` into empty strings), pre-coercing
 * boolean strings (`1/0/yes/no/on/off`) that typebox does not understand, and
 * JSON-parsing array/object values. Unrelated `PATH`/`HOME`-style vars are
 * never included, so they can't fail validation.
 */
export const buildInput = (schema: TObject, source: EnvSource): BuildInputResult => {
  const input: Record<string, unknown> = {};
  const invalidJson = new Map<string, string>();
  const props = properties(schema);
  for (const key of Object.keys(props)) {
    const value = source[key];
    if (value !== undefined) input[key] = value;
  }
  for (const [key, prop] of Object.entries(props)) {
    const value = input[key];
    if (typeof value !== "string") continue;
    if (isBooleanProp(prop)) {
      const coerced = coerceBoolean(value);
      if (coerced !== undefined) input[key] = coerced;
    } else if (isJsonProp(prop)) {
      const parsed = tryJsonParse(value);
      if (parsed !== undefined) input[key] = parsed;
      else invalidJson.set(key, value);
    }
  }
  return { input, invalidJson };
};

/** De-duplicate issues by key, keeping the first occurrence. */
export const dedupeByKey = (issues: EnvIssue[]): EnvIssue[] => {
  const seen = new Set<string>();
  const out: EnvIssue[] = [];
  for (const issue of issues) {
    if (seen.has(issue.key)) continue;
    seen.add(issue.key);
    out.push(issue);
  }
  return out;
};

/** Collect warning issues for optional keys without a default that are unset. */
export const collectOptionalWarnings = (
  schema: TObject,
  input: Record<string, unknown>,
): EnvIssue[] => {
  const props = properties(schema);
  const issues: EnvIssue[] = [];
  for (const [key, prop] of Object.entries(props)) {
    if (!isRequiredKey(schema, key) && !hasDefault(prop) && input[key] === undefined) {
      issues.push({
        code: EnvIssueCodes.MissingOptional,
        severity: "warning",
        key,
        message: `Optional environment variable not set: ${key}`,
      });
    }
  }
  return issues;
};

/**
 * Map per-property validation failures onto structured {@link EnvIssue}s.
 *
 * TypeBox 1.x reports object-level errors (no per-key paths), so each
 * property is checked individually via `Check(prop, value)`.
 */
export const collectErrors = (schema: TObject, defaulted: Record<string, unknown>): EnvIssue[] => {
  const props = properties(schema);
  const issues: EnvIssue[] = [];

  for (const [key, prop] of Object.entries(props)) {
    const secret = isSecret(prop);
    const value = defaulted[key];

    if (value === undefined) {
      if (isRequiredKey(schema, key)) {
        issues.push({
          code: EnvIssueCodes.MissingRequired,
          severity: "error",
          key,
          message: `Missing required environment variable: ${key}`,
          ...(secret ? { secret: true } : {}),
        });
      }
      continue;
    }

    if (!Check(prop, value)) {
      const first = [...Errors(prop, value)][0];
      issues.push({
        code: EnvIssueCodes.Invalid,
        severity: "error",
        key,
        message: `Invalid value for ${key}: ${first?.message ?? describeType(prop)}`,
        expected: describeType(prop),
        ...(secret ? { secret: true } : { got: formatValue(value) }),
      });
    }
  }

  return issues;
};

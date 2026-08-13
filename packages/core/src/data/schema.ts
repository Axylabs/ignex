/**
 * Runtime schema validation.
 *
 * Bun 1.4 edition:
 * - TypeBox / JSON Schema via Ajv
 * - Native fast-gate: when the castrum addon is available AND the schema is a
 *   plain draft-07 object schema (no `default` / `format` / `$ref`), a native
 *   validator is compiled once and used to FAST-ACCEPT valid documents —
 *   skipping the Ajv call on the happy path. Ajv remains the oracle for
 *   detailed errors and for every schema that needs mutation semantics
 *   (`coerceTypes` / `removeAdditional` / `useDefaults`). This is what keeps
 *   schema validation on the faster native (FFI) call instead of a pure-JS
 *   Ajv call when native is available.
 * - Standard Schema v1 via async validation
 * - compiled validator cache
 */

import { createSchemaValidator } from "@ignex/native";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { ValidationError } from "../platform/errors";
import type { AnySchema, StandardSchemaV1 } from "../types";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: true,
  removeAdditional: true,
  useDefaults: true,
});

addFormats(ajv);

const DRAFT7 = "http://json-schema.org/draft-07/schema#";

/**
 * True when a schema is safe for the native fast-ACCEPT gate. The gate only
 * short-circuits when the native validator says the document is VALID, so the
 * only risk is a schema where native accepts something Ajv would reject (or
 * where Ajv would mutate the input). We exclude every known divergence source:
 *
 * - `default` → Ajv injects defaults (useDefaults); native cannot.
 * - `format` → ajv-formats vs the native jsonschema engine can disagree.
 * - `$ref` → external/remote reference resolution differs.
 * - a non-draft-07 `$schema` → draft semantics differ.
 *
 * `coerceTypes` / `removeAdditional` are safe on the ACCEPT path: native only
 * short-circuits when the raw document already conforms, so there is nothing
 * to coerce or remove.
 */
/** Whether a nested schema value is safe for the native fast gate. */
function isFastGateSafeValue(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value)) {
    return value.every((item) => item === null || typeof item !== "object" || isFastGateSafe(item));
  }
  return isFastGateSafe(value);
}

function isFastGateSafe(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  if ("default" in schema || "format" in schema || "$ref" in schema) return false;
  const dollar = (schema as Record<string, unknown>).$schema;
  if (typeof dollar === "string" && dollar !== DRAFT7) return false;
  return Object.values(schema).every(isFastGateSafeValue);
}

interface CompiledValidator {
  /** The public validator closure (cached and returned as-is). */
  run: (input: unknown) => unknown;
  /** The Ajv validator — the full-semantics oracle (details + mutation). */
  ajv: (input: unknown) => boolean;
  /** The native fast-gate validator, or `null` when unavailable / unsafe. */
  native: ReturnType<typeof createSchemaValidator>;
}

const compiledCache = new WeakMap<object, CompiledValidator>();

function isStandardSchema(schema: AnySchema): schema is StandardSchemaV1 {
  return typeof schema === "object" && schema !== null && "~standard" in schema;
}

function toErrorRecord(
  errors: ErrorObject[] | null | undefined,
  on: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};

  for (const e of errors ?? []) {
    const path =
      e.instancePath?.replace(/^\//, "").replace(/\//g, ".") ||
      (e.params as any)?.missingProperty ||
      on;

    out[path] ??= [];
    out[path].push(e.message ?? "Invalid value");
  }

  return out;
}

/** Serialize an input to the wire bytes the native validator expects, or `null`. */
const toNativeBytes = (input: unknown): string | Uint8Array | null =>
  typeof input === "string"
    ? input
    : input instanceof Uint8Array
      ? input
      : input !== null && typeof input === "object"
        ? JSON.stringify(input)
        : null;

/**
 * Fast-accept via the native validator when available; `false` on any native
 * failure so the native path never breaks the public contract (falls through
 * to Ajv for the detailed error).
 */
const nativeFastAccept = (native: CompiledValidator["native"], input: unknown): boolean => {
  if (!native) return false;
  try {
    const bytes = toNativeBytes(input);
    return bytes !== null && native.validate(bytes);
  } catch {
    return false;
  }
};

/**
 * Compile a validator for an `AnySchema`.
 *
 * Returns a synchronous function that validates and returns the input
 * (type-coerced) or throws a {@link ValidationError}. Standard Schema
 * validators are async-only — calling this for one throws a `ValidationError`
 * instructing you to use {@link validateAsync} instead.
 *
 * Compiled validators are cached per schema object (WeakMap).
 *
 * @param schema - The schema to compile.
 * @param on - Field path label used in error records (default `"input"`).
 * @returns A sync validator `(input) => T`.
 * @throws ValidationError on invalid input (or for async-only schemas).
 */
export function compileValidator<T = unknown>(schema: AnySchema, on: string = "input") {
  if (isStandardSchema(schema)) {
    return (_input: unknown): T => {
      throw new ValidationError(
        "Standard Schema validators are async. Use validateAsync() instead of compileValidator().",
        { [on]: ["Standard Schema validators are async"] },
      );
    };
  }

  const schemaKey = schema as object;

  let entry = compiledCache.get(schemaKey);

  if (!entry) {
    const ajvValidate = ajv.compile(schema as object);
    let native: CompiledValidator["native"] = null;
    if (isFastGateSafe(schema)) {
      try {
        native = createSchemaValidator(JSON.stringify(schema));
      } catch {
        native = null; // native availability/compile failure must never break Ajv
      }
    }

    const run = (input: unknown): unknown => {
      // Native fast-gate: for an eligible schema with a live native validator,
      // fast-accept when the raw document validates (skip the Ajv JS call).
      if (nativeFastAccept(native, input)) return input;

      if (!ajvValidate(input)) {
        throw new ValidationError("Validation failed", toErrorRecord(ajvValidate.errors, on), on);
      }

      return input;
    };

    entry = { run, ajv: ajvValidate, native };
    compiledCache.set(schemaKey, entry);
  }

  return entry.run as (input: unknown) => T;
}

/**
 * Validate synchronously, returning the (possibly coerced) input or throwing
 * a {@link ValidationError}.
 *
 * @param schema - The schema to validate against.
 * @param input - The value to validate.
 * @param on - Field path label for error records (default `"input"`).
 * @returns The validated/coerced input.
 * @throws ValidationError on invalid input; for Standard Schema (async-only)
 * schemas, throws instructing you to use {@link validateAsync}.
 */
export function validateOrThrow<T = unknown>(
  schema: AnySchema,
  input: unknown,
  on: string = "input",
): T {
  return compileValidator<T>(schema, on)(input);
}

/**
 * Validate asynchronously (supports Standard Schema), returning the
 * validated/coerced input or throwing a {@link ValidationError}.
 *
 * @param schema - The schema to validate against (sync or Standard Schema).
 * @param input - The value to validate.
 * @param on - Field path label for error records (default `"input"`).
 * @returns The validated/coerced input.
 * @throws ValidationError on invalid input.
 */
export async function validateAsync<T = unknown>(
  schema: AnySchema,
  input: unknown,
  on: string = "input",
): Promise<T> {
  if (isStandardSchema(schema)) {
    const result = await schema["~standard"].validate(input);

    if ("issues" in result) {
      const errors: Record<string, string[]> = {};

      for (const issue of result.issues) {
        const path = issue.path?.join(".") || on;
        errors[path] ??= [];
        errors[path].push(issue.message);
      }

      throw new ValidationError("Validation failed", errors, on);
    }

    return result.value as T;
  }

  return compileValidator<T>(schema, on)(input);
}

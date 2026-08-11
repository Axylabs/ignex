/**
 * Runtime schema validation.
 *
 * Bun 1.4 edition:
 * - TypeBox / JSON Schema via Ajv
 * - Standard Schema v1 via async validation
 * - compiled validator cache
 */

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

const compiledCache = new WeakMap<object, (input: unknown) => unknown>();

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

  let validator = compiledCache.get(schemaKey);

  if (!validator) {
    const validate = ajv.compile(schema as object);

    validator = (input: unknown): unknown => {
      if (!validate(input)) {
        throw new ValidationError("Validation failed", toErrorRecord(validate.errors, on), on);
      }

      return input;
    };

    compiledCache.set(schemaKey, validator);
  }

  return validator as (input: unknown) => T;
}

export function validateOrThrow<T = unknown>(
  schema: AnySchema,
  input: unknown,
  on: string = "input",
): T {
  return compileValidator<T>(schema, on)(input);
}

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

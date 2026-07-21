/**
 * Runtime schema validation.
 *
 * Supports:
 * - TypeBox / JSON Schema via Ajv
 * - Standard Schema v1 via async validation
 */

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { AnySchema, StandardSchemaV1 } from "./types";
import { ValidationError } from "./errors";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: true,
  removeAdditional: true,
  useDefaults: true,
});

addFormats(ajv);

function isStandardSchema(schema: AnySchema): schema is StandardSchemaV1 {
  return typeof schema === "object" && schema !== null && "~standard" in schema;
}

function toErrorRecord(
  errors: ErrorObject[] | null | undefined,
  on: string
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

export function compileValidator<T = unknown>(
  schema: AnySchema,
  on: string = "input"
) {
  if (isStandardSchema(schema)) {
    return (_input: unknown): T => {
      throw new Error(
        "Standard Schema validators are async. Use validateAsync() instead of compileValidator()."
      );
    };
  }

  const validate = ajv.compile(schema as object);

  return (input: unknown): T => {
    if (!validate(input)) {
      throw new ValidationError(
        "Validation failed",
        toErrorRecord(validate.errors, on),
        on
      );
    }

    return input as T;
  };
}

export function validateOrThrow<T = unknown>(
  schema: AnySchema,
  input: unknown,
  on: string = "input"
): T {
  return compileValidator<T>(schema, on)(input);
}

export async function validateAsync<T = unknown>(
  schema: AnySchema,
  input: unknown,
  on: string = "input"
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

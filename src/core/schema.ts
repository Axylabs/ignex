/**
 * @fileoverview Runtime schema validation using TypeBox-compatible JSON Schema + Ajv.
 */

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { AnySchema } from "./types";
import { ValidationError } from "./errors";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: true,
  removeAdditional: true,
  useDefaults: true,
});

addFormats(ajv);

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
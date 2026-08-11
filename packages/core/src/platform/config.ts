/**
 * Typed configuration with environment overrides.
 *
 * `defineConfig` maps a typed schema to a frozen config object, resolving each
 * field from (in order of precedence): explicit overrides → environment →
 * default.
 */
import { fold, tryCatchOr } from "@flux/shared";
import { coerceBoolean } from "./coerce";

export type ConfigFieldType = "string" | "number" | "boolean" | "json";

export interface ConfigField {
  type: ConfigFieldType;
  /** Env var name (defaults to the field key). */
  env?: string;
  default?: unknown;
  required?: boolean;
}

export type ConfigSchema = Record<string, ConfigField>;

type InferType<F extends ConfigField> = F extends { type: "number" }
  ? number
  : F extends { type: "boolean" }
    ? boolean
    : F extends { type: "json" }
      ? unknown
      : string;

export type Config<S extends ConfigSchema> = {
  [K in keyof S]: InferType<S[K]>;
};

const coerce = (field: ConfigField, raw: string | undefined): unknown => {
  if (raw === undefined) return field.default;

  switch (field.type) {
    case "number": {
      const n = Number(raw);
      return Number.isNaN(n) ? field.default : n;
    }
    case "boolean": {
      return coerceBoolean(raw) ?? field.default;
    }
    case "json": {
      // Same fallback semantics as `envJson` (single coercion path).
      return tryCatchOr(field.default, () => JSON.parse(raw));
    }
    default:
      return raw;
  }
};

/**
 * Define a typed config object resolved from overrides → env → defaults.
 * Each schema field is folded into the result object (a `fold` over the
 * schema entries). Throws when a required field is missing everywhere.
 */
export const defineConfig = <const S extends ConfigSchema>(
  schema: S,
  overrides: Partial<Config<S>> = {},
): Config<S> => {
  const entries = Object.entries(schema) as Array<[keyof S & string, ConfigField]>;

  const out = fold({} as Record<string, unknown>, (acc, entry: [keyof S & string, ConfigField]) => {
    const [key, field] = entry;
    if (overrides[key] !== undefined) {
      acc[key] = overrides[key] as unknown;
      return acc;
    }

    const envVar = field.env ?? key;
    const raw = process.env[envVar];

    if (raw === undefined && field.required && field.default === undefined) {
      throw new Error(`Missing required config: ${String(key)} (env: ${envVar})`);
    }

    acc[key] = coerce(field, raw);
    return acc;
  })(entries);

  return Object.freeze(out) as Config<S>;
};

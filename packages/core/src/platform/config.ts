/**
 * Typed configuration with environment overrides.
 *
 * `defineConfig` maps a typed schema to a frozen config object, resolving each
 * field from (in order of precedence): explicit overrides → environment →
 * default.
 */
import { fold, tryCatchOr } from "@ignex/shared";
import { coerceBoolean } from "./coerce";

/** The supported config field value types. */
export type ConfigFieldType = "string" | "number" | "boolean" | "json";

/** One config field: its type, env override, default, and requiredness. */
export interface ConfigField {
  type: ConfigFieldType;
  /** Env var name (defaults to the field key). */
  env?: string;
  default?: unknown;
  required?: boolean;
}

/** A schema of named config fields (the input to {@link defineConfig}). */
export type ConfigSchema = Record<string, ConfigField>;

type InferType<F extends ConfigField> = F extends { type: "number" }
  ? number
  : F extends { type: "boolean" }
    ? boolean
    : F extends { type: "json" }
      ? unknown
      : string;

/** The resolved config object: one typed value per schema field. */
export type Config<S extends ConfigSchema> = {
  [K in keyof S]: InferType<S[K]>;
};

/**
 * Warn once per env var when an invalid value silently falls back to the
 * default (availability-first, like `envJson`) — a typo'd `PORT=3O00` or a
 * malformed JSON env var must be OBSERVABLE, not swallowed. Strict schema
 * validation with structured issues lives in `defineEnv`/`ignex doctor`.
 */
const warnedCoercions = new Set<string>();
const warnBadCoercion = (envVar: string, type: ConfigFieldType, raw: string): void => {
  if (warnedCoercions.has(envVar)) return;
  warnedCoercions.add(envVar);
  console.warn(
    `[ignex] config: invalid ${type} value for ${envVar} (${JSON.stringify(
      raw.length > 80 ? `${raw.slice(0, 80)}…` : raw,
    )}) — using the schema default instead. Fix the env value or use defineEnv for strict validation.`,
  );
};

const coerce = (field: ConfigField, envVar: string, raw: string | undefined): unknown => {
  if (raw === undefined) return field.default;

  switch (field.type) {
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        warnBadCoercion(envVar, "number", raw);
        return field.default;
      }
      return n;
    }
    case "boolean": {
      const b = coerceBoolean(raw);
      if (b === undefined) {
        warnBadCoercion(envVar, "boolean", raw);
        return field.default;
      }
      return b;
    }
    case "json": {
      // Same fallback semantics as `envJson` (single coercion path).
      const parsed = tryCatchOr(field.default, () => JSON.parse(raw));
      if (parsed === field.default && raw.trim() !== JSON.stringify(field.default)) {
        warnBadCoercion(envVar, "json", raw);
      }
      return parsed;
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

    acc[key] = coerce(field, envVar, raw);
    return acc;
  })(entries);

  return Object.freeze(out) as Config<S>;
};

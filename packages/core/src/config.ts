/**
 * Typed configuration with environment overrides.
 *
 * `defineConfig` maps a typed schema to a frozen config object, resolving each
 * field from (in order of precedence): explicit overrides → environment →
 * default.
 */
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
      const normalized = raw.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
      return field.default;
    }
    case "json": {
      try {
        return JSON.parse(raw);
      } catch {
        return field.default;
      }
    }
    default:
      return raw;
  }
};

/**
 * Define a typed config object resolved from overrides → env → defaults.
 * Throws when a required field is missing everywhere.
 */
export const defineConfig = <const S extends ConfigSchema>(
  schema: S,
  overrides: Partial<Config<S>> = {},
): Config<S> => {
  const out = {} as Config<S>;

  for (const [key, field] of Object.entries(schema) as Array<[keyof S & string, ConfigField]>) {
    if (overrides[key] !== undefined) {
      out[key] = overrides[key] as Config<S>[keyof S];
      continue;
    }

    const envVar = field.env ?? key;
    const raw = process.env[envVar];

    if (raw === undefined && field.required && field.default === undefined) {
      throw new Error(`Missing required config: ${String(key)} (env: ${envVar})`);
    }

    out[key] = coerce(field, raw) as Config<S>[keyof S];
  }

  return Object.freeze(out) as Config<S>;
};

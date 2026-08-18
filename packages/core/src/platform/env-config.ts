/**
 * @fileoverview Env-config validation layer — TypeBox schemas for environment
 * variables (required / optional / default / secret) plus a structured
 * error & warning report.
 *
 * Replaces ad-hoc `process.env.X` reads with a validated, typed config:
 *
 * ```ts
 * import { Type, defineEnv } from "@ignex/core/env";
 *
 * const env = defineEnv(
 *   Type.Object({
 *     PORT: Type.Optional(Type.Integer({ default: 3000 })),
 *     DATABASE_URL: Type.String(), // required
 *   }),
 * );
 * ```
 *
 * Semantics:
 * - `Type.String()`                    → required; missing is an error.
 * - `Type.String({ default: "x" })`    → optional with default: a missing var
 *   is silently filled with the default (no warning) and the resolved static
 *   type stays non-null (`string`). This is the recommended way to express an
 *   env var with a default.
 * - `Type.Optional(Type.String({ default: "x" }))` → optional with default,
 *   but the static type is `string | undefined` (the type system can't see the
 *   default). Functionally identical at runtime.
 * - `Type.Optional(Type.String())`     → optional without default; missing
 *   produces an `IGN_ENV_MISSING_OPTIONAL` warning and the type includes
 *   `undefined`.
 * - `Type.String({ metadata: { secret: true } })` → secret; values are
 *   redacted from error messages, warnings, and the report.
 *
 * In short: a `default` makes a variable optional. Wrap in `Type.Optional`
 * only when you want the static type to include `undefined`.
 *
 * `defineEnv` throws a structured {@link EnvError} on errors and emits
 * warnings through the configured sink. `validateEnv` never throws — it
 * returns an {@link EnvResult} report for tooling (doctor, pre-flight,
 * tests). {@link envExampleFromSchema} renders a `.env.example` file from a
 * schema so the two stay in sync.
 */

import type { Static, TObject, TProperties, TSchema } from "typebox";
import { Check, Convert, Default, Errors, Parse } from "typebox/value";
import { coerceBoolean } from "./coerce";
import { loadEnv } from "./env";

// ── diagnostics ───────────────────────────────────────────────────────────

/** Stable env diagnostic codes (public contract — do not rename). */
export const EnvIssueCodes = {
  /** A required variable is absent. */
  MissingRequired: "IGN_ENV_MISSING_REQUIRED",
  /** A variable is present but fails its schema. */
  Invalid: "IGN_ENV_INVALID",
  /** An optional variable without a default is absent. */
  MissingOptional: "IGN_ENV_MISSING_OPTIONAL",
} as const;

/** A stable env diagnostic code (any value of {@link EnvIssueCodes}). */
export type EnvIssueCode = (typeof EnvIssueCodes)[keyof typeof EnvIssueCodes];

/** Severity of an {@link EnvIssue}. */
export type EnvIssueSeverity = "error" | "warning";

/** A single structured env validation issue. */
export interface EnvIssue {
  /** Stable machine-readable code (see {@link EnvIssueCodes}). */
  readonly code: EnvIssueCode;
  /** Whether the issue blocks `defineEnv`. */
  readonly severity: EnvIssueSeverity;
  /** The environment variable name (schema property key). */
  readonly key: string;
  /** Human-readable, actionable message. */
  readonly message: string;
  /** The expected schema type (e.g. "integer", "boolean"). */
  readonly expected?: string;
  /** The offending value (omitted for secrets). */
  readonly got?: string;
  /** True when the key is a secret (value redacted). */
  readonly secret?: boolean;
}

/** The result of a non-throwing {@link validateEnv} call. */
export interface EnvResult<T extends TObject> {
  /** True when there are no error-severity issues. */
  readonly ok: boolean;
  /** The validated, defaulted config — `undefined` when `ok` is false. */
  readonly value: Static<T> | undefined;
  /** All issues (errors + warnings). */
  readonly issues: readonly EnvIssue[];
}

// ── error ─────────────────────────────────────────────────────────────────

/** Renders the full issue list into a single error message. */
const renderEnvError = (issues: readonly EnvIssue[]): string => {
  const parts = issues.map((i) => `${i.key}: ${i.message}`);
  return `Environment validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n  - ${parts.join("\n  - ")}`;
};

/**
 * Thrown by {@link defineEnv} when the environment fails validation.
 *
 * Carries the structured {@link EnvIssue} list so callers can render or
 * surface it however they like. Secret values are never included.
 */
export class EnvError extends Error {
  readonly code = "IGN_ENV_VALIDATION_FAILED";
  /** The structured issues that caused the failure. */
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(renderEnvError(issues));
    this.name = "EnvError";
    this.issues = issues;
  }
}

// ── options ───────────────────────────────────────────────────────────────

/** An environment source (defaults to `process.env`). */
export type EnvSource = Record<string, string | undefined>;

/** Options for {@link defineEnv}. */
export interface DefineEnvOptions {
  /** Load `.env` files first (idempotent). Default `true`. */
  readonly loadEnv?: boolean;
  /** Dotenv paths to load when `loadEnv` is enabled. Default `[".env", ".env.local"]`. */
  readonly envFiles?: readonly string[];
  /** Upgrade warnings to hard errors (throws). Default `false`. */
  readonly strict?: boolean;
  /** Warning sink. Default `console.warn`. Pass `null` to silence. */
  readonly onWarning?: ((issue: EnvIssue) => void) | null;
  /** Environment source. Defaults to `process.env`. */
  readonly source?: EnvSource;
}

/** Options for {@link validateEnv}. */
export interface ValidateEnvOptions {
  /** Environment source. Defaults to `process.env`. */
  readonly source?: EnvSource;
}

// ── schema introspection ──────────────────────────────────────────────────

/** The schema properties of a `TObject`. */
const properties = (schema: TObject): TProperties => schema.properties;

/**
 * True when a key is required — i.e. listed in the schema's `required` array.
 * In TypeBox 1.x, `Type.Optional(...)` marks a key optional by excluding it
 * from `required` (there is no runtime `OptionalKind` marker).
 */
const isRequiredKey = (schema: TObject, key: string): boolean =>
  (schema as { required?: readonly string[] }).required?.includes(key) ?? false;

/** True when a property declares a `default` (via schema options). */
const hasDefault = (prop: TSchema): boolean =>
  (prop as { default?: unknown }).default !== undefined;

/** True when a property is marked secret via `metadata.secret`. */
const isSecret = (prop: TSchema): boolean => {
  const metadata = (prop as { metadata?: { secret?: unknown } }).metadata;
  return metadata?.secret === true;
};

/** A short human-readable description of a property's JSON-schema type. */
const describeType = (prop: TSchema): string => {
  const type = (prop as { type?: unknown }).type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.join(" | ");
  return "value";
};

/** Render an offending value for the report (truncated when long). */
const formatValue = (value: unknown): string => {
  if (value === undefined) return "<unset>";
  const rendered = JSON.stringify(value);
  return rendered.length > 80 ? `${rendered.slice(0, 77)}…` : rendered;
};

// ── core pipeline ─────────────────────────────────────────────────────────

/** True when a property's effective JSON-schema type is boolean. */
const isBooleanProp = (prop: TSchema): boolean => (prop as { type?: unknown }).type === "boolean";

/** True when a property's effective JSON-schema type is array or object. */
const isJsonProp = (prop: TSchema): boolean => {
  const type = (prop as { type?: unknown }).type;
  return type === "array" || type === "object";
};

/** Attempt to JSON.parse a raw env string; returns `undefined` on failure. */
const tryJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/** Result of {@link buildInput}. */
interface BuildInputResult {
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
const buildInput = (schema: TObject, source: EnvSource): BuildInputResult => {
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
const dedupeByKey = (issues: EnvIssue[]): EnvIssue[] => {
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
const collectOptionalWarnings = (schema: TObject, input: Record<string, unknown>): EnvIssue[] => {
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
const collectErrors = (schema: TObject, defaulted: Record<string, unknown>): EnvIssue[] => {
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

/**
 * Validate an environment against a TypeBox object schema without throwing.
 *
 * Returns the parsed (defaulted) config when valid, plus every issue — errors
 * for missing required / invalid values and warnings for unset optional keys
 * without a default. Use this from tooling (doctor, pre-flight, tests);
 * applications use {@link defineEnv}.
 *
 * @param schema - A flat `Type.Object(...)` schema (property key = env var).
 * @param options - Source override (defaults to `process.env`).
 */
export function validateEnv<T extends TObject>(
  schema: T,
  options?: ValidateEnvOptions,
): EnvResult<T> {
  const source = options?.source ?? process.env;
  const { input, invalidJson } = buildInput(schema, source);

  // Unparseable JSON is a hard error: drop the key so TypeBox's Cast can't
  // silently wrap it (e.g. "not-json" → ["not-json"]) and report it directly.
  const parseInput: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!invalidJson.has(key)) parseInput[key] = input[key];
  }

  const props = properties(schema);
  const jsonIssues: EnvIssue[] = [];
  for (const [key, raw] of invalidJson) {
    const prop = props[key];
    const secret = prop !== undefined && isSecret(prop);
    jsonIssues.push({
      code: EnvIssueCodes.Invalid,
      severity: "error",
      key,
      message: `Invalid value for ${key}: expected valid JSON`,
      ...(prop !== undefined ? { expected: describeType(prop) } : {}),
      ...(secret ? { secret: true } : { got: formatValue(raw) }),
    });
  }

  const warnings = collectOptionalWarnings(schema, parseInput);

  // TypeBox 1.x `Parse` neither coerces strings nor fills defaults, so convert
  // (string → number/boolean + defaults) and fill remaining defaults first.
  const converted = Convert(schema, parseInput) as Record<string, unknown>;
  const defaulted = Default(schema, converted) as Record<string, unknown>;

  let value: Static<T> | undefined;
  try {
    value = Parse(schema, defaulted) as Static<T>;
  } catch {
    value = undefined;
  }

  if (jsonIssues.length === 0 && value !== undefined) {
    return { ok: true, value, issues: warnings };
  }

  const errors = collectErrors(schema, defaulted);
  return {
    ok: false,
    value: undefined,
    issues: dedupeByKey([...jsonIssues, ...errors, ...warnings]),
  };
}

/**
 * Validate an environment and return a frozen, fully-typed config.
 *
 * - Loads `.env`/`.env.local` first (unless `loadEnv: false`).
 * - Throws {@link EnvError} when any required variable is missing or any
 *   value is invalid (and, with `strict: true`, on any warning).
 * - Emits warnings for unset optional variables without a default through
 *   `onWarning` (default: `console.warn`).
 *
 * Keys declared with a `default` (not wrapped in `Type.Optional`) keep a
 * non-null static type; keys wrapped in `Type.Optional` keep `| undefined`
 * even when they carry a default (the type system cannot see defaults). The
 * runtime value is always non-null when a default exists.
 *
 * @param schema - A flat `Type.Object(...)` schema (property key = env var).
 * @param options - Loading / strictness / warning behavior.
 * @returns The validated config with defaults applied.
 */
export function defineEnv<T extends TObject>(
  schema: T,
  options: DefineEnvOptions = {},
): Readonly<Static<T>> {
  const shouldLoad = options.loadEnv ?? true;
  const envFiles = options.envFiles ?? [".env", ".env.local"];
  const strict = options.strict ?? false;
  const onWarning = options.onWarning;

  if (shouldLoad) loadEnv([...envFiles]);
  const result = validateEnv(schema, { source: options.source ?? process.env });

  if (!result.ok) throw new EnvError(result.issues);
  if (strict && result.issues.some((issue) => issue.severity === "warning")) {
    throw new EnvError(result.issues);
  }

  for (const issue of result.issues) {
    if (issue.severity !== "warning") continue;
    if (onWarning) {
      onWarning(issue);
    } else {
      console.warn(`⚠ ${issue.key}: ${issue.message}`);
    }
  }

  return Object.freeze({ ...result.value }) as Readonly<Static<T>>;
}

// ── .env.example generation ───────────────────────────────────────────────

/**
 * Render a `.env.example` from a TypeBox object schema.
 *
 * Each variable becomes a commented section (`# REQUIRED` / `# OPTIONAL`)
 * with its default inline, followed by a ready-to-edit `KEY=value` line.
 * Secret variables render with a blank value. Keep the scaffolded
 * `src/config/env.ts` schema and this file in sync by regenerating with
 * `envExampleFromSchema`.
 *
 * @param schema - A flat `Type.Object(...)` schema.
 * @returns The `.env.example` file contents (trailing newline).
 */
export function envExampleFromSchema(schema: TObject): string {
  const props = properties(schema);
  const lines: string[] = [
    "# Environment configuration — copy to .env and adjust:",
    "#   cp .env.example .env",
    "",
  ];

  for (const [key, prop] of Object.entries(props)) {
    const secret = isSecret(prop);
    const optional = !isRequiredKey(schema, key);
    const def = (prop as { default?: unknown }).default;
    const isRequired = !optional && def === undefined;

    const flags = [isRequired ? "REQUIRED" : "OPTIONAL", secret ? "secret" : undefined]
      .filter((f): f is string => f !== undefined)
      .join(" · ");

    if (isRequired) {
      lines.push(`# ${flags} — ${key}`);
      lines.push(`${key}=your-value`);
    } else if (def !== undefined) {
      lines.push(`# ${flags} — ${key} (default: ${String(def)})`);
      lines.push(`${key}=${String(def)}`);
    } else {
      lines.push(`# ${flags} — ${key}`);
      lines.push(`${key}=`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Re-exported for single-import DX (`import { Type, defineEnv } from "@ignex/core/env"`).
export { Type } from "typebox";
// The env subpath also exposes the raw typed accessors (dotenv loading + reads).
export { env, envBool, envFloat, envInt, envJson, envSecret, loadEnv } from "./env";

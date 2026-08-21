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

import type { Static, TObject } from "typebox";
import { Convert, Default, Parse } from "typebox/value";
import { loadEnv } from "./env";
import {
  EnvError,
  type EnvIssue,
  EnvIssueCodes,
  type EnvResult,
  type EnvSource,
} from "./env-diagnostics";
import {
  buildInput,
  collectErrors,
  collectOptionalWarnings,
  dedupeByKey,
  describeType,
  formatValue,
  isRequiredKey,
  isSecret,
  properties,
} from "./env-schema";

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
export {
  EnvError,
  type EnvIssue,
  type EnvIssueCode,
  EnvIssueCodes,
  type EnvIssueSeverity,
  type EnvResult,
  type EnvSource,
} from "./env-diagnostics";

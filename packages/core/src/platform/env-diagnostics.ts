/**
 * @fileoverview Env-config diagnostics — stable issue codes, structured issue
 * types, and the {@link EnvError} thrown by {@link defineEnv}.
 *
 * Split out of `env-config` so the schema helpers (`env-schema`) and the
 * public validation API can share the diagnostics without a circular import.
 */

import type { Static, TObject } from "typebox";

/** An environment source (defaults to `process.env`). */
export type EnvSource = Record<string, string | undefined>;

/** Stable env diagnostic codes (public contract — do not rename). */
export const EnvIssueCodes = {
  /** Required variable missing from the source. */
  MissingRequired: "IGN_ENV_MISSING_REQUIRED",
  /** Value failed schema validation or JSON parsing. */
  Invalid: "IGN_ENV_INVALID",
  /** Optional variable without a default is unset. */
  MissingOptional: "IGN_ENV_MISSING_OPTIONAL",
} as const;

/** A stable env diagnostic code (any value of {@link EnvIssueCodes}). */
export type EnvIssueCode = (typeof EnvIssueCodes)[keyof typeof EnvIssueCodes];

/** Severity of an {@link EnvIssue}. */
export type EnvIssueSeverity = "error" | "warning";

/** A single structured env validation issue. */
export interface EnvIssue {
  readonly code: EnvIssueCode;
  readonly severity: EnvIssueSeverity;
  /** The env var key the issue refers to. */
  readonly key: string;
  readonly message: string;
  /** Expected type for invalid values (human-readable). */
  readonly expected?: string;
  /** The offending value (omitted for secret vars). */
  readonly got?: string;
  /** True for secret vars (value/expected redacted). */
  readonly secret?: boolean;
}

/** Renders the full issue list into a single error message. */
const renderEnvError = (issues: readonly EnvIssue[]): string => {
  const parts = issues.map((i) => `${i.key}: ${i.message}`);
  return `Environment validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n  - ${parts.join("\n  - ")}`;
};

/** The result of a non-throwing {@link validateEnv} call. */
export interface EnvResult<T extends TObject> {
  /** True when every required/invalid check passed (warnings may exist). */
  readonly ok: boolean;
  /** The parsed (defaulted) config when `ok`; `undefined` otherwise. */
  readonly value: Static<T> | undefined;
  /** Every issue found — errors for missing/invalid, warnings for unset optional. */
  readonly issues: readonly EnvIssue[];
}

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

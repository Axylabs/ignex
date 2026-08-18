/**
 * Project env-config pre-flight — loads the project's `src/config/env.ts`
 * module and returns its validation issues without throwing.
 *
 * Shared by `ignex doctor`, `ignex dev` and `ignex build` so the env layer is
 * surfaced consistently. The module's top-level `defineEnv` throws an
 * {@link EnvError} when required variables are missing or invalid; on success
 * the exported `envSchema` is re-validated so warnings surface too.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EnvError, type EnvIssue, EnvIssueCodes, loadEnv, validateEnv } from "@ignex/core/env";
import { exists } from "./fs.js";
import { error, warn } from "./logger.js";

/** Project env-config module (conventional location for `defineEnv`). */
export const ENV_CONFIG_PATH = "src/config/env.ts";

/** Result of {@link checkProjectEnv}. */
export interface EnvCheck {
  /** Env module path (project-relative), or null when absent. */
  readonly file: string | null;
  /** Validation issues (errors + warnings) from the project's env module. */
  readonly issues: readonly EnvIssue[];
}

/**
 * Load and validate the project's env module. Never throws; load failures are
 * reported as a single error issue.
 *
 * @param root - Project root directory.
 * @returns The env module status and validation issues.
 */
export async function checkProjectEnv(root: string): Promise<EnvCheck> {
  const envPath = join(root, ENV_CONFIG_PATH);
  if (!(await exists(envPath))) return { file: null, issues: [] };

  // Load the project's .env files first so validation sees the same env the
  // app would (loadEnv is idempotent and never overrides real env).
  loadEnv([join(root, ".env"), join(root, ".env.local")]);

  try {
    const url = `${pathToFileURL(envPath).href}?t=${Date.now()}`;
    const mod = (await import(url)) as { envSchema?: unknown; schema?: unknown };
    const schema = mod.envSchema ?? mod.schema;
    if (schema && typeof (schema as { properties?: unknown }).properties === "object") {
      return { file: ENV_CONFIG_PATH, issues: [...validateEnv(schema as never).issues] };
    }
    return { file: ENV_CONFIG_PATH, issues: [] };
  } catch (err) {
    if (err instanceof EnvError || (err && Array.isArray((err as { issues?: unknown }).issues))) {
      return { file: ENV_CONFIG_PATH, issues: [...(err as EnvError).issues] };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      file: ENV_CONFIG_PATH,
      issues: [
        {
          code: EnvIssueCodes.Invalid,
          severity: "error",
          key: "(env module)",
          message: `Failed to load ${ENV_CONFIG_PATH}: ${message}`,
        },
      ],
    };
  }
}

/**
 * Log an env check through the CLI logger (errors in red, warnings in yellow).
 * Non-blocking — never sets the exit code.
 *
 * @param check - The env check to report.
 */
export function reportEnvCheck(check: EnvCheck): void {
  if (!check.file) return;
  for (const issue of check.issues) {
    const line = `${issue.key}: ${issue.message}`;
    if (issue.severity === "error") error(`Env: ${line}`);
    else warn(`Env: ${line}`);
  }
}

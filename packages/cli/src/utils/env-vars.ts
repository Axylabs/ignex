/**
 * @fileoverview Feature-bundle env wiring — the generalized form of the
 * `utils/db-env.ts` flow: add each declared env var of an installed feature
 * bundle to the project's env config (`src/config/env.ts` schema entry) and
 * to `.env.example`. Idempotent per key; hand-edited files that don't match
 * the generated shape are left alone with a hint (never mangled).
 */
import { join } from "node:path";
import { envConfigTemplate, envExampleTemplate } from "../templates/env.js";
import { insertIntoEnvSchema } from "./db-env.js";
import { exists, readTextFile, writeFileEnsuringDir } from "./fs.js";
import { success, warn } from "./logger.js";

/** The env var a feature bundle declares (shape from `templates/features.ts`). */
export interface FeatureEnvVar {
  /** Env var name (also the idempotency key). */
  readonly key: string;
  /** Indented schema entry line, e.g. `  KEY: Type.Optional(Type.String()),`. */
  readonly schemaLine: string;
  /** `.env.example` section appended when the var is new. */
  readonly example: string;
}

/**
 * Wire feature env vars into the project: each NEW key gains a schema entry
 * in `src/config/env.ts` and a section in `.env.example`. Existing keys are
 * skipped; the env module is created from the scaffold template when absent.
 *
 * Never touches `.env` — real values stay the operator's (or `ignex ship`'s).
 *
 * @param root - Project root directory.
 * @param vars - The vars to wire (deduped by the caller).
 */
export async function wireFeatureEnvVars(
  root: string,
  vars: readonly FeatureEnvVar[],
): Promise<void> {
  if (vars.length === 0) return;
  await wireEnvSchema(root, vars);
  await wireEnvExample(root, vars);
}

/** Add the missing schema entries to `src/config/env.ts`. Idempotent per key. */
async function wireEnvSchema(root: string, vars: readonly FeatureEnvVar[]): Promise<void> {
  const path = join(root, "src", "config", "env.ts");

  let src: string;
  if (!(await exists(path))) {
    src = envConfigTemplate();
  } else {
    src = await readTextFile(path);
  }

  const missing = vars.filter((envVar) => !src.includes(`${envVar.key}:`));
  if (missing.length === 0) return;

  let next = src;
  for (const envVar of missing) {
    const updated = insertIntoEnvSchema(next, envVar.schemaLine);
    if (updated === null) {
      warn(
        `Could not auto-wire ${envVar.key} into ${path} — add it to envSchema manually:\n  ${envVar.schemaLine}`,
      );
      continue;
    }
    next = updated;
    success(`Added ${envVar.key} to src/config/env.ts`);
  }
  if (next !== src) await writeFileEnsuringDir(path, next);
}

/** Append the missing sections to `.env.example` (creating it when absent). */
async function wireEnvExample(root: string, vars: readonly FeatureEnvVar[]): Promise<void> {
  const path = join(root, ".env.example");

  let src: string;
  if (!(await exists(path))) {
    src = envExampleTemplate();
  } else {
    src = await readTextFile(path);
  }

  const missing = vars.filter((envVar) => !src.includes(`${envVar.key}=`));
  if (missing.length === 0) return;

  let next = src.trimEnd();
  for (const envVar of missing) {
    next = `${next}\n\n${envVar.example}`;
    success(`Added ${envVar.key} to .env.example`);
  }
  await writeFileEnsuringDir(path, `${next}\n`);
}

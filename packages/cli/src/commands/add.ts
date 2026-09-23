/**
 * @fileoverview `ignex add <feature…>` — install feature bundles into an app
 * that already exists.
 *
 * The counterpart to `ignex create --features …` for a project you are already
 * working in: same templates and same vocabulary, but no base files. It adds
 * auth sessions, jobs, SSE, i18n, middleware, the CORS/rate-limit/security/
 * compression/logger plugins, and so on.
 *
 *   ignex add auth                 → src/lib/auth.ts + require-auth hook + auth routes
 *   ignex add auth,refresh         → + refresh/logout + the revocable token store
 *   ignex add cors,security        → src/plugins/index.ts wired into app.config.ts
 *   ignex add middleware           → src/middleware/* + plugins + lifecycle wiring
 *
 * Idempotent by default — files that already exist are skipped (use `--force`
 * to overwrite) and the `src/app.config.ts` edits are additive, so re-running
 * never clobbers hand-written code. `--no-wire` limits the run to file writes.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import {
  FEATURE_LABELS,
  type InstallPlan,
  parseFeatureTokens,
  planInstall,
} from "../templates/features.js";
import { PLUGIN_FEATURES } from "../templates/project.js";
import { FEATURE_NAMES, type Feature } from "../types.js";
import { wireAppConfig } from "../utils/app-config-merge.js";
import { bunWriteFile } from "../utils/bun-compat.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { exists, readTextFile } from "../utils/fs.js";
import { cyan, dim, error, info, step, success, warn } from "../utils/logger.js";
import { addPluginsToModule } from "../utils/plugins-module-merge.js";
import { PromptCancelError, promptMultiSelect } from "../utils/prompt.js";
import { writeScaffold } from "../utils/scaffold.js";
import { metaFor } from "./registry.js";

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  features: {
    type: "positional",
    required: false,
    description: "Feature(s) to install — space or comma separated (e.g. auth refresh)",
  },
  root: { type: "string", valueHint: "dir", description: "Project root" },
  force: { type: "boolean", description: "Overwrite files that already exist" },
  wire: {
    type: "boolean",
    default: true,
    description: "Wire plugins/middleware into src/app.config.ts (--no-wire to skip)",
  },
  "dry-run": {
    type: "boolean",
    description: "List the files that would be written without touching the project",
  },
} satisfies ArgsDef;

export const addCmd = defineCommand({
  meta: metaFor("add"),
  args: argsDef,
  async run(ctx) {
    await runAdd(ctx.rawArgs);
  },
});

export default addCmd;

/**
 * Every feature token on the command line, space or comma separated.
 *
 * The declared positional captures only the first token; the rest stay in
 * `_`, so both `ignex add auth refresh` and `ignex add auth,refresh` work.
 */
const collectFeatureTokens = (parsed: Record<string, unknown>): string[] => {
  const raw = [parsed.features, ...((parsed._ as unknown[] | undefined) ?? [])].filter(
    (value): value is string => typeof value === "string",
  );
  const tokens = raw
    .flatMap((value) => value.split(","))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
};

/** Best-effort read of the app name (`package.json`), used by the tests bundle. */
async function readAppName(root: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      name?: string;
    };
    return pkg.name ?? "ignex-app";
  } catch {
    return "ignex-app";
  }
}

/** Print the feature list in the shared "unknown feature" error shape. */
function printAvailable(): void {
  console.log(`  ${FEATURE_NAMES.map((name) => cyan(name)).join(" ")}`);
}

/** Ask for the features with the shared multi-select (TTY only). */
async function promptFeatures(): Promise<Feature[] | undefined> {
  try {
    const picked = await promptMultiSelect({
      message: "Features to add",
      options: FEATURE_NAMES.map((feature) => ({
        value: feature,
        label: FEATURE_LABELS[feature],
      })),
      initial: ["auth"],
    });
    return picked as Feature[];
  } catch (err) {
    if (err instanceof PromptCancelError) return undefined;
    throw err;
  }
}

/**
 * Write every planned file, skipping existing ones unless `--force`.
 *
 * `src/plugins/index.ts` is special: when it already exists the new plugin
 * factories are MERGED into it, so `ignex add cors` followed by
 * `ignex add security` accumulates instead of skipping the second one.
 */
async function writePlan(
  root: string,
  plan: InstallPlan,
  force: boolean,
): Promise<{ skipped: string[] }> {
  const skipped: string[] = [];
  for (const file of plan.files) {
    const wrote = await writeScaffold(join(root, file.path), file.content(), { force });
    if (!wrote) skipped.push(file.path);
  }

  if (plan.pluginsFile) {
    const path = join(root, plan.pluginsFile.path);
    const names = plan.features.filter((feature) => PLUGIN_FEATURES.includes(feature));
    if (!force && (await exists(path))) {
      const { content, added } = addPluginsToModule(await readTextFile(path), names);
      if (added.length === 0) {
        info(`${plan.pluginsFile.path} already registers ${names.join(", ")}.`);
      } else {
        await bunWriteFile(path, content);
        success(
          `Registered ${added.map((name) => `${name}()`).join(", ")} in ${plan.pluginsFile.path}`,
        );
      }
    } else if (!(await writeScaffold(path, plan.pluginsFile.content(), { force }))) {
      skipped.push(plan.pluginsFile.path);
    }
  }

  return { skipped };
}

/** Apply the planned `src/app.config.ts` wiring (additive, idempotent). */
async function applyWiring(root: string, plan: InstallPlan): Promise<void> {
  if (!plan.wire.plugins && !plan.wire.middleware) return;

  const appConfig = join(root, "src", "app.config.ts");
  if (!(await exists(appConfig))) {
    warn(
      "No src/app.config.ts found — spread src/plugins/index.ts into your plugins array manually.",
    );
    return;
  }

  const source = await readFile(appConfig, "utf8");
  const { content, changes, patchedPluginsArray } = wireAppConfig(source, plan.wire);

  if (changes.length === 0) {
    if (patchedPluginsArray) info("src/app.config.ts is already wired.");
    else {
      warn(
        "No `export const plugins = [...]` array in src/app.config.ts — wire the new plugins manually.",
      );
    }
    return;
  }

  await bunWriteFile(appConfig, content);
  success(`Wired ${changes.join(", ")} into ${relative(process.cwd(), appConfig) || appConfig}`);
  if (!patchedPluginsArray) {
    warn(
      "No `export const plugins = [...]` array in src/app.config.ts — spread the new plugins manually.",
    );
  }
}

/** Print the dry-run plan (files + follow-up notes). */
function printPlan(plan: InstallPlan, label: string): void {
  step(`${plan.features.join(", ")} → ${label} (dry run, nothing written)`);
  for (const file of plan.files) console.log(`  ${cyan("+")} ${file.path}`);
  if (plan.pluginsFile) console.log(`  ${cyan("+")} ${plan.pluginsFile.path}`);
  if (plan.files.length === 0 && !plan.pluginsFile) {
    console.log(`  ${dim("(no files — this feature is already part of the baseline app)")}`);
  }
  printNotes(plan);
}

/** Print the follow-up notes an install plan carries. */
function printNotes(plan: InstallPlan): void {
  if (plan.notes.length === 0) return;
  console.log();
  for (const note of plan.notes) info(note);
}

/** Explain the wiring `--no-wire` asked us to skip. */
function printWiringHint(plan: InstallPlan): void {
  const hints: string[] = [];
  if (plan.wire.plugins) {
    hints.push('spread `...appPlugins` from "./plugins/index.js" into the `plugins` array');
  }
  if (plan.wire.middleware) {
    hints.push(
      "spread `...middleware` and add `beforeHandle: [logRequests(), markResponse()]` to `lifecycle`",
    );
  }
  if (hints.length > 0) console.log(`\nℹ --no-wire in src/app.config.ts: ${hints.join("; ")}.`);
}

/** Print the post-install summary. */
function printSummary(plan: InstallPlan, skipped: readonly string[]): void {
  console.log();
  success(`Added ${plan.features.join(", ")}`);
  if (skipped.length > 0) {
    warn(`Skipped ${skipped.length} existing file(s) — pass --force to overwrite:`);
    for (const path of skipped) console.log(`  ${dim(path)}`);
  }
  printNotes(plan);
  console.log();
  console.log(`Next: ${cyan("ignex dev")}`);
}

/** Run `ignex add` — parse, plan, write, wire, report. */
export async function runAdd(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);
  const root = await resolveProjectRoot(parsed.root);

  let tokens = collectFeatureTokens(parsed);
  if (tokens.length === 0 && process.stdin.isTTY) {
    const picked = await promptFeatures();
    if (!picked) return; // wizard cancelled
    tokens = picked;
  }

  if (tokens.length === 0) {
    error("No features given. Try: ignex add auth");
    printAvailable();
    process.exitCode = 1;
    return;
  }

  const { features, unknown } = parseFeatureTokens(tokens);
  if (unknown.length > 0) {
    error(`Unknown feature${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    printAvailable();
    process.exitCode = 1;
    return;
  }
  if (features.size === 0) {
    error("No features selected.");
    printAvailable();
    process.exitCode = 1;
    return;
  }

  const plan = planInstall(features, await readAppName(root));
  const label = relative(process.cwd(), root) || ".";

  if (parsed.dryRun === true) {
    printPlan(plan, label);
    return;
  }

  step(`Adding ${plan.features.join(", ")} to ${label}`);
  const { skipped } = await writePlan(root, plan, parsed.force === true);
  if (parsed.wire === false) printWiringHint(plan);
  else await applyWiring(root, plan);
  printSummary(plan, skipped);
}

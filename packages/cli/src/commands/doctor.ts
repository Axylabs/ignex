/**
 * @fileoverview `ignex doctor` — project health diagnostics.
 *
 * Reports runtime, native acceleration, config, routes directory, and compiled
 * server status. Sets a non-zero exit code when blocking issues are found
 * (e.g. a missing routes directory), so it can gate CI or onboarding scripts.
 */

import { join } from "node:path";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { CONFIG_FILES, loadConfig } from "../utils/config.js";
import { exists } from "../utils/fs.js";
import { error, success } from "../utils/logger.js";
import { nativeLabel, nativeStatus } from "../utils/native.js";

/** Diagnostics report for a project (see {@link collectDoctorReport}). */
export interface DoctorReport {
  /** Project root the report was collected for. */
  readonly root: string;
  /** Runtime versions. */
  readonly runtime: {
    /** Bun version when running under Bun, else null. */
    readonly bun: string | null;
    /** Node.js version string. */
    readonly node: string;
  };
  /** Native acceleration status. */
  readonly native: {
    /** True when the Rust addon is loaded. */
    readonly available: boolean;
    /** Active execution backend ("castrum" | "js" | "unknown"). */
    readonly backend: string;
  };
  /** Detected config filename, or null when none is present. */
  readonly configFile: string | null;
  /** Routes directory status. */
  readonly routes: {
    /** Routes directory path (project-relative). */
    readonly dir: string;
    /** True when the directory exists. */
    readonly exists: boolean;
  };
  /** Compiled server entry status. */
  readonly server: {
    /** Server path relative to the project root. */
    readonly path: string;
    /** True when the compiled server file exists. */
    readonly exists: boolean;
  };
  /** Blocking problems found; empty when the project is healthy. */
  readonly issues: readonly string[];
}

/** Routes directory default when the config omits it (compiler parity). */
const DEFAULT_ROUTES_DIR = "src/routes";
/** Out directory default when the config omits it (compiler parity). */
const DEFAULT_OUT_DIR = ".ignex";
/** Out file default when the config omits it (compiler parity). */
const DEFAULT_OUT_FILE = "server.js";

/**
 * Collect a doctor report for the project at `--root` (or the first
 * positional, or cwd). Never throws; problems are surfaced as report issues.
 *
 * @param args - Raw CLI args (`--root <dir>`).
 * @returns The structured health report.
 */
export async function collectDoctorReport(args: string[]): Promise<DoctorReport> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
  });

  const root = resolveRoot(values, positionals);
  const issues: string[] = [];

  const config = await loadConfig(root);

  let configFile: string | null = null;
  for (const file of CONFIG_FILES) {
    if (await exists(join(root, file))) {
      configFile = file;
      break;
    }
  }

  const routesDir = typeof config.routesDir === "string" ? config.routesDir : DEFAULT_ROUTES_DIR;
  const routesExists = await exists(join(root, routesDir));
  if (!routesExists) issues.push(`routes directory not found: ${routesDir}`);

  const outDir = typeof config.outDir === "string" ? config.outDir : DEFAULT_OUT_DIR;
  const outFile = typeof config.outFile === "string" ? config.outFile : DEFAULT_OUT_FILE;
  const serverPath = join(outDir, outFile);
  const serverExists = await exists(join(root, serverPath));
  if (!serverExists) issues.push(`no compiled server at ${serverPath} — run \`ignex build\``);

  const native = await nativeStatus();

  return {
    root,
    runtime: {
      bun: process.versions.bun ?? null,
      node: process.version,
    },
    native,
    configFile,
    routes: { dir: routesDir, exists: routesExists },
    server: { path: serverPath, exists: serverExists },
    issues,
  };
}

/**
 * Render a doctor report as printable lines (one per check).
 *
 * @param report - The report to render.
 * @returns Human-readable lines; the final line summarizes any issues.
 */
export function renderDoctor(report: DoctorReport): string[] {
  const runtime = report.runtime.bun ? `bun ${report.runtime.bun}` : `node ${report.runtime.node}`;

  const lines: string[] = [];
  lines.push(`Doctor: ${report.root}`);
  lines.push(`Runtime: ${runtime}`);
  lines.push(`Native: ${nativeLabel(report.native)}`);
  lines.push(`Config: ${report.configFile ?? "none (compiler defaults)"}`);
  lines.push(`Routes: ${report.routes.dir} ${report.routes.exists ? "✔" : "✖ missing"}`);
  lines.push(
    `Server: ${report.server.path} ${report.server.exists ? "✔" : "not built — run `ignex build`"}`,
  );
  if (report.issues.length > 0) {
    lines.push(`${report.issues.length} problem(s) found`);
  } else {
    lines.push("All checks passed");
  }
  return lines;
}

/**
 * Run `ignex doctor`: print the report and set a non-zero exit code when
 * blocking issues are found.
 *
 * @param args - Raw CLI args forwarded to {@link collectDoctorReport}.
 */
export async function runDoctor(args: string[]): Promise<void> {
  const report = await collectDoctorReport(args);

  for (const line of renderDoctor(report)) {
    console.log(line);
  }

  if (report.issues.length > 0) {
    for (const issue of report.issues) {
      error(issue);
    }
    process.exitCode = 1;
    return;
  }

  success("Project is healthy");
}

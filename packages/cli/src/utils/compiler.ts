import { isAbsolute, join } from "node:path";
import { type CompileResult, type CompilerOptions, formatDiagnostic } from "@flux/compiler";
import { loadConfig } from "./config.js";
import { exists } from "./fs.js";
import { error, step, warn } from "./logger.js";

/**
 * CLI flags are mapped to real CompilerOptions names here.
 * Never pass raw CLI names directly into the compiler.
 */
const CLI_TO_COMPILER: Partial<Record<string, keyof CompilerOptions>> = {
  routesDir: "routesDir",
  hooksDir: "hooksDir",
  outDir: "outDir",
  outFile: "outFile",
  minify: "minify",
  sourcemap: "sourceMap",
  sourceMap: "sourceMap",
  target: "target",
  cache: "routeCache",
  routeCache: "routeCache",
};

function mapCliFlags(flags: Record<string, unknown>): Partial<CompilerOptions> {
  const out: Partial<CompilerOptions> = {};

  for (const [cliKey, compilerKey] of Object.entries(CLI_TO_COMPILER)) {
    if (compilerKey !== undefined && flags[cliKey] !== undefined) {
      (out as Record<string, unknown>)[compilerKey] = flags[cliKey];
    }
  }

  return out;
}

export interface BuildOutcome {
  /** Effective compiler options used for the build. */
  readonly opts: CompilerOptions;
  /** Structured compile result including diagnostics. */
  readonly result: CompileResult;
}

/** Compile the project and surface structured compiler diagnostics. */
export async function buildProject(
  root: string,
  flags: Record<string, unknown>,
): Promise<BuildOutcome> {
  const config = await loadConfig(root);

  let compiler: typeof import("@flux/compiler");
  try {
    compiler = await import("@flux/compiler");
  } catch (err) {
    throw new Error(
      `Failed to load @flux/compiler. Make sure it is installed in your workspace.\n${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const input: Record<string, unknown> = { ...config };
  Object.assign(input, mapCliFlags(flags));

  const opts = compiler.mergeOptions(input as Partial<CompilerOptions>);

  step(`Compiling ${String(opts.routesDir ?? "src/routes")} → ${String(opts.outDir ?? ".flux")}`);

  const result = await compiler.buildAsync(opts);

  // Surface structured compiler diagnostics (warnings and errors).
  for (const d of result.warnings) warn(formatDiagnostic(d));
  for (const d of result.errors) error(formatDiagnostic(d));

  return { opts, result };
}

export async function findServerEntry(
  root: string,
  opts: CompilerOptions,
): Promise<string | undefined> {
  const outDir = opts.outDir ?? ".flux";
  const outFile = opts.outFile ?? "server.js";

  const candidates = [
    join(outDir, outFile),
    join(outDir, "server.js"),
    join(outDir, "server.mjs"),
    join(outDir, "index.js"),
    join(outDir, "entry.js"),
    ".flux/server.js",
    "dist/server.js",
    "dist/__server.js",
  ]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .map((x) => (isAbsolute(x) ? x : join(root, x)));

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

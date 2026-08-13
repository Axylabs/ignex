import { isAbsolute, join } from "node:path";
import { type CompileResult, type CompilerOptions, formatDiagnostic } from "@ignus/compiler";
import { loadConfig } from "./config.js";
import { exists } from "./fs.js";
import { step, warn } from "./logger.js";

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
  target: "target",
  cache: "routeCache",
  routeCache: "routeCache",
  verbose: "verbose",
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

/**
 * Compiler option keys that are filesystem paths. `outFile` is intentionally
 * excluded — it is a basename joined under `outDir`.
 */
const ROOTED_PATH_KEYS = ["routesDir", "hooksDir", "outDir", "appConfig"] as const;

/**
 * Resolve project-relative compiler paths against `root`. The compiler treats
 * these as cwd-relative, so without this a non-cwd `--root` (e.g. running
 * `ignus build --root ../app` from a monorepo root) scans the wrong directory
 * and emits an empty server. Absolute values pass through unchanged.
 */
function resolveRootedPaths(root: string, input: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...input };

  for (const key of ROOTED_PATH_KEYS) {
    const value = resolved[key];
    if (typeof value !== "string" || value.length === 0) continue;
    resolved[key] = isAbsolute(value) ? value : join(root, value);
  }

  return resolved;
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

  let compiler: typeof import("@ignus/compiler");
  try {
    compiler = await import("@ignus/compiler");
  } catch (err) {
    throw new Error(
      `Failed to load @ignus/compiler. Make sure it is installed in your workspace.\n${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const input: Record<string, unknown> = { ...config };
  Object.assign(input, mapCliFlags(flags));

  // Single rooting pass AFTER mergeOptions: the compiler defaults (`./src/routes`,
  // `.ignus`) are also relative, so pre-rooting the input first would be redundant
  // work against two sources of truth. Absolute values pass through unchanged.
  const opts = compiler.mergeOptions(input as Partial<CompilerOptions>);
  const rootedOpts = {
    ...opts,
    ...resolveRootedPaths(root, opts as unknown as Record<string, unknown>),
  } as CompilerOptions;

  step(
    `Compiling ${String(rootedOpts.routesDir ?? "src/routes")} → ${String(
      rootedOpts.outDir ?? ".ignus",
    )}`,
  );

  // Fail loudly on a missing/typo'd routes directory instead of silently
  // emitting an empty server (which would 404 every route at runtime).
  if (!(await exists(rootedOpts.routesDir))) {
    throw new Error(`Routes directory not found: ${rootedOpts.routesDir}`);
  }

  const result = await compiler.buildAsync(rootedOpts);

  // Surface structured compiler diagnostics. `buildAsync` throws on errors, so
  // only warnings need to be printed here.
  for (const d of result.warnings) warn(formatDiagnostic(d));

  return { opts: rootedOpts, result };
}

export async function findServerEntry(
  root: string,
  opts: CompilerOptions,
): Promise<string | undefined> {
  const outDir = opts.outDir ?? ".ignus";
  const outFile = opts.outFile ?? "server.js";

  // Candidates are all joined under the (already rooted) `outDir`; the hardcoded
  // root-relative `.ignus`/`dist` tails were leftover heuristics that duplicated
  // the configured output and are undocumented — dropped.
  const candidates = [
    join(outDir, outFile),
    join(outDir, "server.js"),
    join(outDir, "server.mjs"),
    join(outDir, "index.js"),
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

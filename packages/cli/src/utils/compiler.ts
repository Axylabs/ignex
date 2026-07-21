import { isAbsolute, join, resolve } from "node:path";
import { exists } from "./fs.js";
import { loadConfig } from "./config.js";
import { step } from "./logger.js";

/**
 * CLI flags are mapped to real CompilerOptions names here.
 * Never pass raw CLI names directly into the compiler.
 */
const CLI_TO_COMPILER: Record<string, string> = {
  routesDir: "routesDir",
  hooksDir: "hooksDir",
  outDir: "outDir",
  outFile: "outFile",
  minify: "minify",
  sourcemap: "sourceMap",
  sourceMap: "sourceMap",
  target: "target",
  router: "router",
  routerMode: "router",
  cache: "routeCache",
  routeCache: "routeCache",
};

function mapCliFlags(flags: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [cliKey, compilerKey] of Object.entries(CLI_TO_COMPILER)) {
    if (flags[cliKey] !== undefined) {
      out[compilerKey] = flags[cliKey];
    }
  }

  return out;
}

export async function buildProject(
  root: string,
  flags: Record<string, unknown>,
): Promise<any> {
  const config = await loadConfig(root);

  let compiler: any;
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

  const opts =
    typeof compiler.mergeOptions === "function"
      ? compiler.mergeOptions(input)
      : input;

  const build = compiler.buildAsync ?? compiler.build;

  if (typeof build !== "function") {
    throw new Error("@flux/compiler does not export buildAsync or build.");
  }

  step(
    `Compiling ${String(opts.routesDir ?? "src/routes")} → ${String(
      opts.outDir ?? ".flux",
    )}`,
  );

  await build(opts);

  return opts;
}

export async function findServerEntry(
  root: string,
  opts: any,
): Promise<string | undefined> {
  const outDir = typeof opts?.outDir === "string" ? opts.outDir : ".flux";
  const outFile = typeof opts?.outFile === "string" ? opts.outFile : "server.js";

  const candidates = [
    opts?.output,
    opts?.serverEntry,
    opts?.entry,
    opts?.outFile ? join(outDir, opts.outFile) : undefined,
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
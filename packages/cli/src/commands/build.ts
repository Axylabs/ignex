/**
 * `ignex build` — AOT-compile the app into a production-shaped server artifact.
 *
 *   ignex build                 → production-shaped build (dev tooling eliminated)
 *   ignex build --dev           → dev-shaped artifact (debugbar/tracing kept)
 *   ignex build --watch         → same as `ignex dev`
 *   ignex build --compile       → also emit a standalone binary
 *
 * Pre-flight env validation runs first (warnings/errors non-blocking), then
 * the compiler, then the realtime artifact. `--root <dir>` or auto-discovery.
 */
import { isAbsolute, join } from "node:path";
import type { CompilerOptions } from "@ignex/compiler";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import { buildProject } from "../utils/compiler.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { checkProjectEnv, reportEnvCheck } from "../utils/env-check.js";
import { error, formatError, info, success, warn } from "../utils/logger.js";
import { nativeLabel, nativeStatus } from "../utils/native.js";
import { metaFor } from "./registry.js";

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  root: { type: "string", valueHint: "dir", description: "Project root" },
  "out-dir": { type: "string", valueHint: "dir", description: "Compiler output directory" },
  "routes-dir": { type: "string", valueHint: "dir", description: "Routes directory" },
  minify: { type: "boolean", description: "Minify the emitted server" },
  sourcemap: { type: "boolean", description: "Emit source maps" },
  verbose: { type: "boolean", description: "Verbose compiler output" },
  watch: { type: "boolean", description: "Watch + rebuild + run (same as ignex dev)" },
  compile: { type: "boolean", description: "Also compile a standalone binary" },
  "binary-outfile": {
    type: "string",
    valueHint: "name",
    description: "Binary filename for --compile",
  },
  bytecode: { type: "boolean", description: "Emit bytecode along the binary" },
  dev: { type: "boolean", description: "Dev-shaped build (keeps debugbar/tracing in)" },
} satisfies ArgsDef;

export const buildCmd = defineCommand({
  meta: metaFor("build"),
  args: argsDef,
  async run(ctx) {
    await runBuild(ctx.rawArgs);
  },
});

export default buildCmd;

/** Mirror of the linker's binary output path resolution (for the status line). */
const binaryPath = (opts: CompilerOptions): string => {
  if (opts.binaryOutfile) {
    return isAbsolute(opts.binaryOutfile)
      ? opts.binaryOutfile
      : join(opts.outDir, opts.binaryOutfile);
  }
  return join(opts.outDir, opts.serviceName ?? "ignex");
};

export async function runBuild(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);

  if (parsed.watch) {
    const { runDev } = await import("./dev.js");
    await runDev(args);
    return;
  }

  const root = await resolveProjectRoot(parsed.root);

  info(`Building ${root}`);

  // Production shape by DEFAULT: `ignex build` is the deploy artifact command,
  // so the compiler eliminates dev-only tooling (the debugbar dashboard and
  // its per-request tracing instrumentation), bakes the production TLS policy
  // and defaults to safe error responses — even when this process runs with
  // NODE_ENV unset. `--dev` opts out (a dev-shaped artifact, e.g. to attach
  // the debugbar to a staging build); `IGNEX_DEBUG=1` at build time also opts
  // back into the debugbar within an otherwise production-shaped build.
  const devShaped = parsed.dev === true;
  const buildFlags: Record<string, unknown> = { ...parsed };
  if (!devShaped) buildFlags.production = true;

  try {
    // Pre-flight env validation (non-blocking warnings/errors).
    reportEnvCheck(await checkProjectEnv(root));
    if (devShaped) {
      warn(
        "Dev-shaped build (--dev): the debugbar and tracing instrumentation stay compiled in. " +
          "Do not ship this artifact to production.",
      );
    } else {
      info("Production shape: dev-only plugins eliminated (IGNEX_DEBUG=1 opts back in)");
    }

    // `buildProject` handles the realtime bootstrap (realtime.json + local
    // SDK regeneration) before compiling — see utils/compiler.ts.
    const { opts } = await buildProject(root, buildFlags);
    const status = await nativeStatus();
    info(`Native: ${nativeLabel(status)}`);
    if (opts.compile) info(`Binary: ${binaryPath(opts)}`);
    success("Build complete");
  } catch (err) {
    error(formatError(err));
    process.exitCode = 1;
  }
}

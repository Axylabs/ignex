import { isAbsolute, join } from "node:path";
import type { CompilerOptions } from "@ignex/compiler";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { buildProject } from "../utils/compiler.js";
import { error, formatError, info, success } from "../utils/logger.js";
import { nativeLabel, nativeStatus } from "../utils/native.js";

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
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    outDir: { type: "string" },
    routesDir: { type: "string" },
    minify: { type: "boolean" },
    sourcemap: { type: "boolean" },
    verbose: { type: "boolean" },
    watch: { type: "boolean" },
    compile: { type: "boolean" },
    "binary-outfile": { type: "string" },
    bytecode: { type: "boolean" },
  });

  if (values.watch) {
    const { runDev } = await import("./dev.js");
    await runDev(args);
    return;
  }

  const root = resolveRoot(values, positionals);

  info(`Building ${root}`);

  try {
    const { opts } = await buildProject(root, values as Record<string, unknown>);
    const status = await nativeStatus();
    info(`Native: ${nativeLabel(status)}`);
    if (opts.compile) info(`Binary: ${binaryPath(opts)}`);
    success("Build complete");
  } catch (err) {
    error(formatError(err));
    process.exitCode = 1;
  }
}

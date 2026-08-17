import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { buildProject } from "../utils/compiler.js";
import { error, formatError, info, success } from "../utils/logger.js";
import { nativeLabel, nativeStatus } from "../utils/native.js";

export async function runBuild(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    outDir: { type: "string" },
    routesDir: { type: "string" },
    minify: { type: "boolean" },
    sourcemap: { type: "boolean" },
    verbose: { type: "boolean" },
    watch: { type: "boolean" },
  });

  if (values.watch) {
    const { runDev } = await import("./dev.js");
    await runDev(args);
    return;
  }

  const root = resolveRoot(values, positionals);

  info(`Building ${root}`);

  try {
    await buildProject(root, values as Record<string, unknown>);
    const status = await nativeStatus();
    info(`Native: ${nativeLabel(status)}`);
    success("Build complete");
  } catch (err) {
    error(formatError(err));
    process.exitCode = 1;
  }
}

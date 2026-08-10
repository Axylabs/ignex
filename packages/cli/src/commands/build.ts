import { parseArgs } from "node:util";
import { buildProject } from "../utils/compiler.js";
import { error, info, success } from "../utils/logger.js";

export async function runBuild(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      root: { type: "string" },
      outDir: { type: "string" },
      routesDir: { type: "string" },
      minify: { type: "boolean" },
      sourcemap: { type: "boolean" },
      verbose: { type: "boolean" },
      watch: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.watch) {
    const { runDev } = await import("./dev.js");
    await runDev(args);
    return;
  }

  const root = (values.root as string | undefined) ?? positionals[0] ?? ".";

  info(`Building ${root}`);

  try {
    await buildProject(root, values as Record<string, unknown>);
    success("Build complete");
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

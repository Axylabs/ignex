import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";

export async function runInfo(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
  });

  const root = resolveRoot(values, positionals);
  const config = await loadConfig(root);

  console.log(
    JSON.stringify(
      {
        cwd: root,
        runtime: process.versions.bun ? "bun" : "node",
        node: process.version,
        bun: process.versions.bun ?? null,
        config,
      },
      null,
      2,
    ),
  );
}

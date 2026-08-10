import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../utils/config.js";

export async function runInfo(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      root: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const root = resolve((values.root as string | undefined) ?? positionals[0] ?? ".");
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

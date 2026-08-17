import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { nativeStatus } from "../utils/native.js";

export async function runInfo(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
  });

  const root = resolveRoot(values, positionals);
  const config = await loadConfig(root);
  const native = await nativeStatus();

  console.log(
    JSON.stringify(
      {
        cwd: root,
        runtime: process.versions.bun ? "bun" : "node",
        node: process.version,
        bun: process.versions.bun ?? null,
        native: {
          available: native.available,
          backend: native.backend,
        },
        config,
      },
      null,
      2,
    ),
  );
}

import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { routeFileTemplate } from "../templates/route.js";
import { loadConfig } from "../utils/config.js";
import { exists, writeFileEnsuringDir } from "../utils/fs.js";
import { error, info, step, success } from "../utils/logger.js";
import { parseRouteInput } from "../utils/route.js";

export async function runRoute(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      root: { type: "string" },
      dir: { type: "string" },
      method: { type: "string" },
      schema: { type: "boolean" },
      named: { type: "boolean" },
      force: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  const root = resolve((values.root as string | undefined) ?? ".");

  let input = positionals[0];

  if (!input && process.stdin.isTTY) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    input = await rl.question("Route path (e.g. products/[id].get): ");
    rl.close();
  }

  if (!input) {
    error("Route path is required.");
    process.exitCode = 1;
    return;
  }

  const parsed = parseRouteInput(input, values.method as string | undefined);

  const config = await loadConfig(root);

  const routesDir = resolve(
    root,
    (values.dir as string | undefined) ??
      (typeof config.routesDir === "string" ? config.routesDir : "src/routes"),
  );

  const filePath = join(routesDir, parsed.file);

  if ((await exists(filePath)) && !values.force) {
    error(`${relative(process.cwd(), filePath)} already exists. Use --force to overwrite.`);
    process.exitCode = 1;
    return;
  }

  step(`Creating ${parsed.method.toUpperCase()} ${parsed.routePath}`);

  await writeFileEnsuringDir(
    filePath,
    routeFileTemplate(parsed, {
      schema: Boolean(values.schema),
      named: Boolean(values.named),
    }),
  );

  success(`Created ${relative(process.cwd(), filePath)}`);

  if (values.schema) {
    info("Schema template uses @sinclair/typebox. Install it if missing:");
    info("  bun add @sinclair/typebox");
  }

  if (values.named) {
    info(
      "Route uses a named export (export const httpGet = ...). The compiler accepts both styles.",
    );
  }
}

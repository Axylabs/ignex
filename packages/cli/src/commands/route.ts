import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { routeFileTemplate } from "../templates/route.js";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { exists, writeFileEnsuringDir } from "../utils/fs.js";
import { error, info, step, success } from "../utils/logger.js";
import { ask, askConfirm, openPrompt } from "../utils/prompt.js";
import { parseRouteInput } from "../utils/route.js";

export async function runRoute(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    dir: { type: "string" },
    method: { type: "string" },
    schema: { type: "boolean" },
    named: { type: "boolean" },
    force: { type: "boolean" },
  });

  // The first positional is the route path, not a root path.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });

  let input = positionals[0];

  if (!input && process.stdin.isTTY) {
    const rl = openPrompt();
    input = await ask(rl, "Route path (e.g. products/[id].get)");
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
    info("Schema template uses typebox.");
    // Offer to add the dependency when it is not already declared, mirroring
    // `ignex create --features examples` (which adds it for you).
    const pkgPath = join(root, "package.json");
    let hasTypebox = false;
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      hasTypebox = Boolean(pkg.dependencies?.["typebox"] ?? pkg.devDependencies?.["typebox"]);
    } catch {
      // No package.json — leave the hint only.
    }

    if (!hasTypebox && process.stdin.isTTY) {
      const rl = openPrompt();
      try {
        const install = await askConfirm(rl, "Add typebox?", true);
        if (install) {
          const pm = detectPm(root);
          const result = spawnSync(pm, ["add", "typebox"], {
            cwd: root,
            stdio: "inherit",
          });
          if (result.status === 0) {
            success("Installed typebox.");
          }
        }
      } finally {
        rl.close();
      }
    } else if (!hasTypebox) {
      info("  Install it if missing: bun add typebox");
    }
  }

  if (values.named) {
    info(
      "Route uses a named export (export const httpGet = ...). The compiler accepts both styles.",
    );
  }
}

/** Best-effort package manager detection from lockfiles, defaulting to bun. */
const detectPm = (root: string): "bun" | "npm" | "pnpm" | "yarn" => {
  const has = (f: string): boolean => existsSync(join(root, f));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("package-lock.json")) return "npm";
  return "bun";
};

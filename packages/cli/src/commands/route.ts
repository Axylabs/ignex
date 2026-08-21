import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { moduleFileTemplate, modulePathFor, routeWithModuleTemplate } from "../templates/module.js";
import { routeFileTemplate } from "../templates/route.js";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { error, info, step, success } from "../utils/logger.js";
import { PromptCancelError, promptConfirm, promptSelect, promptText } from "../utils/prompt.js";
import { parseRouteInput, ROUTE_METHODS } from "../utils/route.js";
import { resolveDir, writeScaffold } from "../utils/scaffold.js";

/** True when the raw input already carries a dot-method suffix (`health.get`). */
const hasExplicitMethod = (input: string): boolean =>
  /\.(get|post|put|patch|del|delete|all)$/i.test(input.replace(/\.ts$/i, ""));

/**
 * `ignex route <path>` — scaffold a route file plus its business-logic module.
 *
 * By default every route also gets `src/modules/<route>.ts` (the logic) and a
 * thin route file that calls the module's `handle()`; pass `--no-module` for
 * the classic single-file route. Interactive mode asks for the path and, when
 * the path carries no method suffix, the HTTP method.
 */
export async function runRoute(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    dir: { type: "string" },
    method: { type: "string" },
    schema: { type: "boolean" },
    named: { type: "boolean" },
    module: { type: "boolean" },
    force: { type: "boolean" },
  });

  // The first positional is the route path, not a root path.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });

  // Bun's parseArgs turns `--no-module` into the literal "no-module" key.
  const noModule = (values as Record<string, unknown>)["no-module"] === true;
  const withModule = values.module === true ? true : !noModule;

  let input = positionals[0];
  const interactive = Boolean(process.stdin.isTTY);

  if (!input && interactive) {
    try {
      input = await promptText({
        message: "Route path (e.g. products/[id].get)",
        initial: "",
      });
    } catch (err) {
      if (err instanceof PromptCancelError) return;
      throw err;
    }
  }

  if (!input) {
    error("Route path is required.");
    process.exitCode = 1;
    return;
  }

  let methodFlag = values.method as string | undefined;
  if (!methodFlag && !hasExplicitMethod(input) && interactive) {
    try {
      methodFlag = await promptSelect({
        message: "HTTP method",
        options: ROUTE_METHODS.map((m) => ({ value: m })),
        initial: "get",
      });
    } catch (err) {
      if (err instanceof PromptCancelError) return;
      throw err;
    }
  }

  const parsed = parseRouteInput(input, methodFlag);

  const config = await loadConfig(root);

  const routesDir = resolveDir(root, values.dir, config.routesDir, "src/routes");
  const filePath = join(routesDir, parsed.file);

  step(`Creating ${parsed.method.toUpperCase()} ${parsed.routePath}`);

  if (withModule) {
    // 1. The business-logic module (src/modules/<route>.ts).
    const modulesDir = resolveDir(root, undefined, config.modulesDir, "src/modules");
    const modulePath = join(modulesDir, parsed.file);
    await writeScaffold(modulePath, moduleFileTemplate(parsed), {
      force: Boolean(values.force),
    });
    // 2. The thin route file that calls the module.
    if (
      !(await writeScaffold(
        filePath,
        routeWithModuleTemplate(parsed, {
          schema: Boolean(values.schema),
          named: Boolean(values.named),
        }),
        { force: Boolean(values.force), overwrite: true },
      ))
    ) {
      return;
    }
    info(`Business logic goes in ${modulePathFor(parsed)} — routes stay thin.`);
  } else if (
    !(await writeScaffold(
      filePath,
      routeFileTemplate(parsed, {
        schema: Boolean(values.schema),
        named: Boolean(values.named),
      }),
      { force: Boolean(values.force), overwrite: true },
    ))
  ) {
    return;
  }

  if (values.schema) {
    info("Schema template uses typebox.");
    await maybeInstallTypebox(root);
  }

  if (values.named) {
    info(
      "Route uses a named export (export const httpGet = ...). The compiler accepts both styles.",
    );
  }
}

/**
 * Offer to add the `typebox` dependency when the schema template needs it and
 * the project doesn't have it yet (mirrors `ignex create --features examples`).
 */
async function maybeInstallTypebox(root: string): Promise<void> {
  const pkgPath = join(root, "package.json");
  let hasTypebox = false;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    hasTypebox = Boolean(pkg.dependencies?.typebox ?? pkg.devDependencies?.typebox);
  } catch {
    // No package.json — leave the hint only.
  }

  if (!hasTypebox && process.stdin.isTTY) {
    try {
      const install = await promptConfirm({ message: "Add typebox?", initial: true });
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
    } catch {
      // cancelled — the hint below still explains the manual step
    }
  } else if (!hasTypebox) {
    info("  Install it if missing: bun add typebox");
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

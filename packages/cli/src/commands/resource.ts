/**
 * `ignex resource <Name>` — scaffold a ninox model + pregenerated CRUD routes.
 *
 *   ignex resource User --fields "email:string,role:enum(admin,user)" --rbac
 *
 * Generates:
 *   src/models/<plural>.ts              (schema-first model)
 *   src/routes/api/<plural>/*.ts         (list/read/create/update/delete)
 *   src/db.ts                           (toolkit bootstrap, if missing)
 *   src/lib/http.ts                      (shared id/error helpers, if missing)
 *
 * `--auth` pre-wires `config.hooks = ["require-auth"]` (AOT named hook);
 * `--rbac` pre-wires `withGuards(..., { permissions: [...] })` (compiler emits
 * the guard chain — works in both runtimes).
 */
import { join, relative, resolve } from "node:path";
import { dbTemplate, modelTemplate, parseModelFields, pluralize } from "../templates/model.js";
import {
  httpLibTemplate,
  resourceReadmeTemplate,
  resourceRouteTemplates,
} from "../templates/resource.js";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { exists, writeFileEnsuringDir } from "../utils/fs.js";
import { error, info, step, success } from "../utils/logger.js";

export async function runResource(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    dir: { type: "string" },
    fields: { type: "string" },
    auth: { type: "boolean" },
    rbac: { type: "boolean" },
    force: { type: "boolean" },
  });

  // The first positional is the resource *name*, not a root path.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });
  const name = positionals[0];

  if (!name) {
    error("Resource name is required (e.g. ignex resource User).");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(root);
  const modelsDir = resolve(
    root,
    (values.dir as string | undefined) ??
      (config as { modelsDir?: string }).modelsDir ??
      "src/models",
  );
  const routesDir = resolve(
    root,
    typeof config.routesDir === "string" ? config.routesDir : "src/routes",
  );

  const fields = parseModelFields(values.fields as string | undefined);
  const plural = pluralize(name);
  const modelPath = join(modelsDir, `${plural}.ts`);
  const dbPath = join(root, "src", "db.ts");
  const opts = { auth: Boolean(values.auth), rbac: Boolean(values.rbac) };

  if ((await exists(modelPath)) && !values.force) {
    error(`${relative(process.cwd(), modelPath)} already exists. Use --force to overwrite.`);
    process.exitCode = 1;
    return;
  }

  step(`Scaffolding resource ${name} (collection "${plural}")`);

  // 1. The model.
  await writeFileEnsuringDir(modelPath, modelTemplate(name, fields));
  success(`Created ${relative(process.cwd(), modelPath)}`);

  // 2. The CRUD routes under src/routes/api/<plural>/.
  for (const { path, content } of resourceRouteTemplates(name, opts)) {
    const filePath = join(routesDir, "api", path);
    if ((await exists(filePath)) && !values.force) continue;
    await writeFileEnsuringDir(filePath, content);
    success(`Created ${relative(process.cwd(), filePath)}`);
  }
  await writeFileEnsuringDir(
    join(routesDir, "api", plural, "README.md"),
    resourceReadmeTemplate(name),
  );
  success(`Created ${relative(process.cwd(), join(routesDir, "api", plural, "README.md"))}`);

  // 3. The DB bootstrap (once per project; the user merges further models).
  if (!(await exists(dbPath)) || values.force) {
    await writeFileEnsuringDir(dbPath, dbTemplate(name));
    success(`Created ${relative(process.cwd(), dbPath)}`);
  } else {
    info(
      `Skipped ${relative(process.cwd(), dbPath)} (already exists). Add ${plural} to its collections map.`,
    );
  }

  // 4. The shared route helpers (once per project; safe to keep/extend).
  const httpLibPath = join(root, "src", "lib", "http.ts");
  if (!(await exists(httpLibPath)) || values.force) {
    await writeFileEnsuringDir(httpLibPath, httpLibTemplate());
    success(`Created ${relative(process.cwd(), httpLibPath)}`);
  } else {
    info(`Skipped ${relative(process.cwd(), httpLibPath)} (already exists).`);
  }

  if (opts.auth || opts.rbac) {
    const hints: string[] = [];
    if (opts.auth) hints.push("add authModule() to your plugins (EdDSA JWT)");
    if (opts.rbac) hints.push("permissions use the `<collection>:read|write` convention");
    info(`Guards pre-wired — ${hints.join("; ")}.`);
  }
}

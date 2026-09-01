/**
 * `ignex resource <Name>` — scaffold a ninox model + pregenerated CRUD routes.
 *
 *   ignex resource User --fields "email:string,role:enum(admin,user)" --rbac
 *
 * Generates:
 *   src/models/<plural>.ts              (schema-first model)
 *   src/routes/api/<plural>/*.ts         (list/read/create/update/delete)
 *   src/db.ts                           (toolkit bootstrap, if missing)
 *
 * `--auth` pre-wires `config.hooks = ["require-auth"]` (AOT named hook);
 * `--rbac` pre-wires `withGuards(..., { permissions: [...] })` (compiler emits
 * the guard chain — works in both runtimes).
 */
import { join, relative } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import {
  drizzleConfigTemplate,
  drizzleDbTemplate,
  drizzleModelTemplate,
} from "../templates/drizzle.js";
import { drizzleResourceTemplates } from "../templates/drizzle-resource.js";
import {
  dbTemplate,
  type ModelField,
  modelTemplate,
  parseModelFields,
  pluralize,
} from "../templates/model.js";
import {
  guardsTemplate,
  resourceReadmeTemplate,
  resourceRouteTemplates,
} from "../templates/resource.js";
import { loadConfig } from "../utils/config.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { exists, readTextFile, writeFileEnsuringDir } from "../utils/fs.js";
import { error, info, step, success } from "../utils/logger.js";
import { resolveDir, writeScaffold } from "../utils/scaffold.js";
import { metaFor } from "./registry.js";

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  name: {
    type: "positional",
    required: false,
    description: "Resource name in PascalCase (e.g. User)",
  },
  root: { type: "string", valueHint: "dir", description: "Project root" },
  dir: { type: "string", valueHint: "dir", description: "Override the models directory" },
  fields: {
    type: "string",
    valueHint: "list",
    description: "Comma-separated fields (name:string, age:integer, ...)",
  },
  auth: { type: "boolean", description: 'Pre-wire config.hooks = ["require-auth"]' },
  rbac: {
    type: "boolean",
    description: "Pre-wire withGuards(..., { permissions: [...] }) boilerplate",
  },
  force: { type: "boolean", description: "Overwrite existing files" },
  db: {
    type: "string",
    valueHint: "mongo|sql",
    description: "Data layer (mongo default; sql = Drizzle)",
  },
} satisfies ArgsDef;

export const resourceCmd = defineCommand({
  meta: metaFor("resource"),
  args: argsDef,
  async run(ctx) {
    await runResource(ctx.rawArgs);
  },
});

export default resourceCmd;

/**
 * Register `dbPlugin()` in `src/app.config.ts` so the ninox toolkit connects at
 * boot. Without it, `db` (a live proxy over `service.db.primaryClient`) stays
 * unconnected and every CRUD route fails with "undefined is not an object
 * (evaluating 'db.insertOne')".
 *
 * Only rewrites configs matching the generated shape (`export const plugins = [`
 * and the `import ... from "..."` block); hand-edited configs are left alone
 * with a hint. Idempotent — never duplicates the plugin/import.
 */
export async function wireDbPlugin(root: string): Promise<void> {
  const configPath = join(root, "src", "app.config.ts");
  if (!(await exists(configPath))) {
    info("No src/app.config.ts found — add dbPlugin() to your plugins array once you have one.");
    return;
  }

  const config = await readTextFile(configPath);
  if (config.includes("dbPlugin")) return; // already wired
  if (!config.includes("export const plugins = [")) {
    info("src/app.config.ts doesn't expose a plugins array — add dbPlugin() to it manually.");
    return;
  }

  // 1. Add the plugin entry right after `export const plugins = [`.
  const withEntry = config.replace(
    "export const plugins = [\n",
    "export const plugins = [\n  dbPlugin(),\n",
  );
  if (withEntry === config) {
    info("Could not wire dbPlugin() into src/app.config.ts — add it manually.");
    return;
  }
  // 2. Add the import after the LAST `import ...` line. Only write when both
  // edits land, so we never emit a config that references an undefined dbPlugin.
  const lines = withEntry.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trimStart().startsWith("import ")) lastImport = i;
  }
  if (lastImport === -1) {
    info("Could not add the dbPlugin import — add it to src/app.config.ts manually.");
    return;
  }
  lines.splice(lastImport + 1, 0, 'import { dbPlugin } from "./db.js";');
  const withImport = lines.join("\n");
  await writeFileEnsuringDir(configPath, withImport);
  success("Registered dbPlugin() in src/app.config.ts (connects MongoDB at boot).");
}

/** Dependencies the generated models/routes import but `ignex create` may omit. */
const RESOURCE_DEPS = ["@ignex/ninox", "typebox"] as const;

/**
 * Add `@ignex/ninox` (toolkit) and `typebox` (route param schemas) to
 * `package.json` dependencies when missing — otherwise a freshly scaffolded
 * resource imports modules that aren't installed and the app can't build.
 * No-op when there's no package.json (or deps already present).
 */
export async function ensureResourceDeps(root: string): Promise<void> {
  const pkgPath = join(root, "package.json");
  if (!(await exists(pkgPath))) return;

  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readTextFile(pkgPath)) as { dependencies?: Record<string, string> };
  } catch {
    return; // unparseable package.json — leave it alone
  }
  if (!pkg.dependencies) pkg.dependencies = {};
  const deps = pkg.dependencies;
  const added = RESOURCE_DEPS.filter((dep) => !deps[dep]);
  if (added.length === 0) return;
  for (const dep of added) deps[dep] = "latest";
  await writeFileEnsuringDir(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  success(`Added ${added.join(", ")} to package.json dependencies.`);
}

/**
 * Merge a newly scaffolded collection into an existing generated `src/db.ts`:
 * model import + `defineCollections(...)` member + a `createSchema(...)` call.
 * Guards on the generated shape — a hand-edited db.ts that doesn't match is
 * left untouched (with a hint) instead of being mangled.
 */
export async function addCollectionToDb(root: string, plural: string): Promise<void> {
  const dbPath = join(root, "src", "db.ts");
  if (!(await exists(dbPath))) return;

  const src = await readTextFile(dbPath);
  if (src.includes(`import { ${plural} } from "./models/${plural}.js";`)) {
    return; // already wired
  }

  const next = src
    // 1. Model import, after the first `import ... from "./models/...js";`.
    .replace(
      /(import \{[^}]*\} from "\.\/models\/[^"]+\.js";\n)/,
      `$1import { ${plural} } from "./models/${plural}.js";\n`,
    )
    // 2. Add to defineCollections(...) — keeps any existing members.
    .replace(
      /(defineCollections\([^)]*?)(\))/,
      (_match: string, prefix: string, close: string) => `${prefix}, ${plural}${close}`,
    )
    // 3. Provision the schema at boot (matches the indentation of each call).
    .replace(
      /(\n(\s*)await db\.createSchema\("[^"]+"\);)/g,
      `$1$2await db.createSchema("${plural}");`,
    );

  if (next === src) {
    info(`Could not auto-wire ${plural} into src/db.ts — add it to the collections map manually.`);
    return;
  }
  await writeFileEnsuringDir(dbPath, next);
  success(`Added ${plural} to src/db.ts collections.`);
}

export async function runResource(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);

  // The first positional is the resource *name*, not a root path.
  const root = await resolveProjectRoot(parsed.root);
  const name = parsed.name;
  if (!name) {
    error("Resource name is required (e.g. ignex resource User).");
    process.exitCode = 1;
    return;
  }

  const dbKind = parsed.db === "sql" ? "sql" : "mongo";
  const config = await loadConfig(root);
  const modelsDir = resolveDir(root, parsed.dir, config.modelsDir, "src/models");
  const routesDir = resolveDir(root, undefined, config.routesDir, "src/routes");

  let fields: ModelField[];
  try {
    fields = parseModelFields(parsed.fields);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return;
  }
  const plural = pluralize(name);
  const modelPath = join(modelsDir, `${plural}.ts`);
  const dbPath = join(root, "src", "db.ts");
  const dbSqlPath = join(root, "src", "db-sql.ts");
  const drizzleConfigPath = join(root, "drizzle.config.ts");
  const opts = { auth: Boolean(parsed.auth), rbac: Boolean(parsed.rbac) };

  step(
    `Scaffolding resource ${name} (${dbKind === "sql" ? "Drizzle/SQLite" : `collection "${plural}"`})`,
  );

  if (dbKind === "sql") {
    // ── Drizzle (SQL) path ──────────────────────────────────────────────
    if (
      !(await writeScaffold(modelPath, drizzleModelTemplate(name, fields), {
        force: Boolean(parsed.force),
        overwrite: true,
      }))
    ) {
      return;
    }

    for (const { path, content } of drizzleResourceTemplates(
      name,
      fields.map((f) => f.line.split(":")[0]?.trim() ?? "field"),
    )) {
      // drizzle paths already include the `api/` prefix.
      await writeScaffold(join(routesDir, path), content, {
        force: Boolean(parsed.force),
      });
    }

    // db-sql.ts + drizzle.config.ts are idempotent (never overwrite a custom
    // client once present).
    await writeScaffold(dbSqlPath, drizzleDbTemplate());
    await writeScaffold(drizzleConfigPath, drizzleConfigTemplate());

    // Install drizzle-orm + typebox (imported by the generated files).
    await ensureDrizzleDeps(root);

    if (opts.auth || opts.rbac) {
      info("SQL resources: add auth hooks via config.hooks (drizzle has no guard pre-wiring yet).");
    }
    return;
  }

  // ── Mongo (ninox) path ────────────────────────────────────────────────
  // 1. The model (blocking exists/--force gate).
  if (
    !(await writeScaffold(modelPath, modelTemplate(name, fields), {
      force: Boolean(parsed.force),
      overwrite: true,
    }))
  ) {
    return;
  }

  // 2. The CRUD routes under src/routes/api/<plural>/ (best-effort skip).
  for (const { path, content } of resourceRouteTemplates(name, opts)) {
    await writeScaffold(join(routesDir, "api", path), content, {
      force: Boolean(parsed.force),
    });
  }
  await writeScaffold(join(routesDir, "api", plural, "README.md"), resourceReadmeTemplate(name), {
    force: Boolean(parsed.force),
  });

  // 2b. The RBAC guard boilerplate (`src/lib/guards.ts`) — generated once,
  // never overwritten: it is the app's own guard template (withGuards lives
  // here, not in the framework) and users extend it with business rules.
  await writeGuardsBoilerplate(root);

  // 3. The DB bootstrap. Once src/db.ts exists it is NEVER regenerated (that
  // would drop other collections) — new resources are merged in instead.
  if (!(await writeScaffold(dbPath, dbTemplate(name)))) {
    info(`Skipped ${relative(process.cwd(), dbPath)} (already exists).`);
    await addCollectionToDb(root, plural);
  }

  // 3b. Wire dbPlugin() into src/app.config.ts so the toolkit connects at boot.
  await wireDbPlugin(root);

  // 3c. Ensure the ninox toolkit + typebox are installed (imported by the
  // generated model/routes/db.ts).
  await ensureResourceDeps(root);

  // 4. Guards hint (auth/RBAC pre-wiring).
  if (opts.auth || opts.rbac) {
    const hints: string[] = [];
    if (opts.auth) hints.push("add authModule() to your plugins (EdDSA JWT)");
    if (opts.rbac) hints.push("permissions use the `<collection>:read|write` convention");
    info(`Guards pre-wired — ${hints.join("; ")}.`);
  }
}

/** Install drizzle-orm (the generated SQL resource imports it). */
async function ensureDrizzleDeps(root: string): Promise<void> {
  const pkgPath = join(root, "package.json");
  try {
    const pkg = JSON.parse(await readTextFile(pkgPath)) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    const added = ["drizzle-orm", "drizzle-kit"].filter((dep) => !deps[dep]);
    if (added.length === 0) return;
    for (const dep of added) deps[dep] = "latest";
    await writeFileEnsuringDir(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    success(`Added ${added.join(", ")} to package.json dependencies.`);
  } catch {
    info("Add manually: bun add drizzle-orm drizzle-kit");
  }
}

/** Write the app's guard boilerplate (src/lib/guards.ts) once, never overwrite. */
async function writeGuardsBoilerplate(root: string): Promise<void> {
  const guardsPath = join(root, "src", "lib", "guards.ts");
  if (await writeScaffold(guardsPath, guardsTemplate(), { force: false })) {
    info(
      `Wrote guard boilerplate ${relative(process.cwd(), guardsPath)} (edit it to add your guards).`,
    );
  }
}

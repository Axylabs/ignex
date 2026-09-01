/**
 * @fileoverview `ignex hotroute <Name>` — scaffold a ninox model + a
 * hot-cache-backed resource split into thin routes and `src/modules/<plural>/`
 * logic.
 *
 *   ignex hotroute Gig --fields "name:string,date:date"
 *
 * Generates:
 *   src/models/<plural>.ts                        (schema-first model)
 *   src/modules/<plural>/<plural>.cache.ts        (shared HotCache)
 *   src/modules/<plural>/{get,list,post,patch,del}.ts  (per-op logic)
 *   src/routes/api/<plural>/*.ts                  (thin HTTP layers)
 *   src/db.ts                                     (toolkit bootstrap, if missing)
 *   + dbPlugin() wiring into src/app.config.ts + deps
 */
import { join, relative } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import {
  hotModuleTemplates,
  hotResourceReadmeTemplate,
  hotRouteTemplates,
} from "../templates/hotroute.js";
import {
  dbTemplate,
  type ModelField,
  modelTemplate,
  parseModelFields,
  pluralize,
} from "../templates/model.js";
import { loadConfig } from "../utils/config.js";
import { wireDbEnv } from "../utils/db-env.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { error, info, step } from "../utils/logger.js";
import { resolveDir, writeScaffold } from "../utils/scaffold.js";
import { metaFor } from "./registry.js";
import { addCollectionToDb, ensureResourceDeps, wireDbPlugin } from "./resource.js";

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
    description: "Comma-separated fields",
  },
  force: { type: "boolean", description: "Overwrite existing files" },
} satisfies ArgsDef;

export const hotrouteCmd = defineCommand({
  meta: metaFor("hotroute"),
  args: argsDef,
  async run(ctx) {
    await runHotRoute(ctx.rawArgs);
  },
});

export default hotrouteCmd;

/** Run `ignex hotroute`. */
export async function runHotRoute(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);

  // The first positional is the resource *name*, not a root path.
  const root = await resolveProjectRoot(parsed.root);
  const name = parsed.name;
  if (!name) {
    error("Hot route name is required (e.g. ignex hotroute User).");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(root);
  const modelsDir = resolveDir(root, parsed.dir, config.modelsDir, "src/models");
  const routesDir = resolveDir(root, undefined, config.routesDir, "src/routes");
  const srcDir = join(root, "src");

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

  step(`Scaffolding hot route ${name} (collection "${plural}")`);

  // 1. The model (blocking exists/--force gate).
  if (
    !(await writeScaffold(modelPath, modelTemplate(name, fields), {
      force: parsed.force === true,
      overwrite: true,
    }))
  ) {
    return;
  }

  // 2. The module logic (src/modules/<plural>/) — paths are relative to src/.
  for (const { path, content } of hotModuleTemplates(name)) {
    await writeScaffold(join(srcDir, path), content, { force: parsed.force === true });
  }

  // 3. The thin routes (src/routes/api/<plural>/) — paths are relative to
  // src/routes/.
  for (const { path, content } of hotRouteTemplates(name)) {
    await writeScaffold(join(routesDir, path), content, { force: parsed.force === true });
  }
  await writeScaffold(
    join(routesDir, "api", plural, "README.md"),
    hotResourceReadmeTemplate(name),
    { force: parsed.force === true },
  );

  // 4. The DB bootstrap. Once src/db.ts exists it is NEVER regenerated (that
  // would drop other collections) — new resources are merged in instead. On
  // FIRST creation, wire MONGO_URL into the env config so the generated db.ts
  // resolves its connection URL from env.ts.
  if (!(await writeScaffold(dbPath, dbTemplate(name)))) {
    info(`Skipped ${relative(process.cwd(), dbPath)} (already exists).`);
    await addCollectionToDb(root, plural);
  } else {
    await wireDbEnv(root, "mongo");
  }

  // 5. Wire dbPlugin() into src/app.config.ts so the toolkit connects at boot,
  // and ensure the ninox toolkit + typebox are installed.
  await wireDbPlugin(root);
  await ensureResourceDeps(root);
}

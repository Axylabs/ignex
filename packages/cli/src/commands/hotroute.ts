/**
 * `ignex hotroute <Name>` — scaffold a ninox model + a hot-cache-backed
 * resource split into thin routes and `src/modules/<plural>/` logic.
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
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { error, info, step } from "../utils/logger.js";
import { firstPositional, resolveDir, writeScaffold } from "../utils/scaffold.js";
import { addCollectionToDb, ensureResourceDeps, wireDbPlugin } from "./resource.js";

export async function runHotRoute(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    dir: { type: "string" },
    fields: { type: "string" },
    force: { type: "boolean" },
  });

  // The first positional is the resource *name*, not a root path.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });
  const name = firstPositional(
    positionals,
    "Hot route name is required (e.g. ignex hotroute User).",
  );
  if (!name) return;

  const config = await loadConfig(root);
  const modelsDir = resolveDir(root, values.dir, config.modelsDir, "src/models");
  const routesDir = resolveDir(root, undefined, config.routesDir, "src/routes");
  const srcDir = join(root, "src");

  let fields: ModelField[];
  try {
    fields = parseModelFields(values.fields as string | undefined);
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
      force: Boolean(values.force),
      overwrite: true,
    }))
  ) {
    return;
  }

  // 2. The module logic (src/modules/<plural>/) — paths are relative to src/.
  for (const { path, content } of hotModuleTemplates(name)) {
    await writeScaffold(join(srcDir, path), content, { force: Boolean(values.force) });
  }

  // 3. The thin routes (src/routes/api/<plural>/) — paths are relative to
  // src/routes/.
  for (const { path, content } of hotRouteTemplates(name)) {
    await writeScaffold(join(routesDir, path), content, { force: Boolean(values.force) });
  }
  await writeScaffold(
    join(routesDir, "api", plural, "README.md"),
    hotResourceReadmeTemplate(name),
    { force: Boolean(values.force) },
  );

  // 4. The DB bootstrap. Once src/db.ts exists it is NEVER regenerated (that
  // would drop other collections) — new resources are merged in instead.
  if (!(await writeScaffold(dbPath, dbTemplate(name)))) {
    info(`Skipped ${relative(process.cwd(), dbPath)} (already exists).`);
    await addCollectionToDb(root, plural);
  }

  // 5. Wire dbPlugin() into src/app.config.ts so the toolkit connects at boot,
  // and ensure the ninox toolkit + typebox are installed.
  await wireDbPlugin(root);
  await ensureResourceDeps(root);
}

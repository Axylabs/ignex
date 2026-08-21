/**
 * `ignex factory <Name>` — scaffold a test-data factory for a ninox model.
 *
 *   ignex factory User --fields "email:string(format email),role:enum(admin,editor)"
 *
 * Writes `src/factories/<plural>.ts` with a typed `make<Model>()` factory that
 * generates randomized field values (per the model field DSL). The factory
 * imports the model's schema type so the return type is `InferDoc`-compatible,
 * and wires into `ignex seed` via a generated `seedFactories` helper.
 */
import { join } from "node:path";
import { factoryTemplate } from "../templates/factory.js";
import { type ModelField, parseModelFields, pluralize } from "../templates/model.js";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { error, step } from "../utils/logger.js";
import { firstPositional, resolveDir, writeScaffold } from "../utils/scaffold.js";

export async function runFactory(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    dir: { type: "string" },
    fields: { type: "string" },
    force: { type: "boolean" },
  });

  // The first positional is the model *name*, not a root path.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });
  const name = firstPositional(positionals, "Model name is required (e.g. ignex factory User).");
  if (!name) return;

  const config = await loadConfig(root);
  const factoriesDir = resolveDir(root, values.dir, config.factoriesDir, "src/factories");

  let fields: ModelField[];
  try {
    fields = parseModelFields(values.fields as string | undefined);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return;
  }
  const plural = pluralize(name);
  const filePath = join(factoriesDir, `${plural}.ts`);

  step(`Creating factory for ${name} (src/factories/${plural}.ts)`);
  await writeScaffold(filePath, factoryTemplate(name, fields), {
    force: Boolean(values.force),
    overwrite: true,
  });
}

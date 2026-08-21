/**
 * `ignex model <Name>` — scaffold a ninox schema-first model.
 *
 *   ignex model User --fields "email:string(format email),role:enum(admin,editor)"
 *
 * Writes `src/models/<plural>.ts` (idempotent; `--force` overwrites).
 */
import { join } from "node:path";
import { type ModelField, modelTemplate, parseModelFields, pluralize } from "../templates/model.js";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { error, step } from "../utils/logger.js";
import { firstPositional, resolveDir, writeScaffold } from "../utils/scaffold.js";

export async function runModel(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    dir: { type: "string" },
    fields: { type: "string" },
    force: { type: "boolean" },
  });

  // The first positional is the model *name*, not a root path.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });
  const name = firstPositional(positionals, "Model name is required (e.g. ignex model User).");
  if (!name) return;

  const config = await loadConfig(root);
  const modelsDir = resolveDir(root, values.dir, config.modelsDir, "src/models");

  let fields: ModelField[];
  try {
    fields = parseModelFields(values.fields as string | undefined);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return;
  }
  const plural = pluralize(name);
  const filePath = join(modelsDir, `${plural}.ts`);

  step(`Creating model ${name} (collection "${plural}")`);
  await writeScaffold(filePath, modelTemplate(name, fields), {
    force: Boolean(values.force),
    overwrite: true,
  });
}

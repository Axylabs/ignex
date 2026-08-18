/**
 * `ignex model <Name>` — scaffold a ninox schema-first model.
 *
 *   ignex model User --fields "email:string(format email),role:enum(admin,editor)"
 *
 * Writes `src/models/<plural>.ts` (idempotent; `--force` overwrites).
 */
import { join, relative, resolve } from "node:path";
import { modelTemplate, parseModelFields, pluralize } from "../templates/model.js";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { exists, writeFileEnsuringDir } from "../utils/fs.js";
import { error, step, success } from "../utils/logger.js";

export async function runModel(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    dir: { type: "string" },
    fields: { type: "string" },
    force: { type: "boolean" },
  });

  // The first positional is the model *name*, not a root path.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });
  const name = positionals[0];

  if (!name) {
    error("Model name is required (e.g. ignex model User).");
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

  const fields = parseModelFields(values.fields as string | undefined);
  const plural = pluralize(name);
  const filePath = join(modelsDir, `${plural}.ts`);

  if ((await exists(filePath)) && !values.force) {
    error(`${relative(process.cwd(), filePath)} already exists. Use --force to overwrite.`);
    process.exitCode = 1;
    return;
  }

  step(`Creating model ${name} (collection "${plural}")`);
  await writeFileEnsuringDir(filePath, modelTemplate(name, fields));
  success(`Created ${relative(process.cwd(), filePath)}`);
}

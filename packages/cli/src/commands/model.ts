/**
 * @fileoverview `ignex model <Name>` — scaffold a ninox schema-first model.
 *
 *   ignex model User --fields "email:string(format email),role:enum(admin,editor)"
 *
 * Writes `src/models/<plural>.ts` (idempotent; `--force` overwrites).
 */
import { join } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import { type ModelField, modelTemplate, parseModelFields, pluralize } from "../templates/model.js";
import { loadConfig } from "../utils/config.js";
import { ensureDeps } from "../utils/deps.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { error, step } from "../utils/logger.js";
import { resolveDir, writeScaffold } from "../utils/scaffold.js";
import { metaFor } from "./registry.js";

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  name: {
    type: "positional",
    required: false,
    description: "Model name in PascalCase (e.g. User)",
  },
  root: { type: "string", valueHint: "dir", description: "Project root" },
  dir: { type: "string", valueHint: "dir", description: "Override the models directory" },
  fields: {
    type: "string",
    valueHint: "list",
    description: "Comma-separated fields (name:string, age:integer, role:enum(a,b), ...)",
  },
  force: { type: "boolean", description: "Overwrite an existing model file" },
} satisfies ArgsDef;

export const modelCmd = defineCommand({
  meta: metaFor("model"),
  args: argsDef,
  async run(ctx) {
    await runModel(ctx.rawArgs);
  },
});

export default modelCmd;

/** Run `ignex model`. */
export async function runModel(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);

  // The first positional is the model *name*, not a root path.
  const root = await resolveProjectRoot(parsed.root);
  const name = parsed.name;
  if (!name) {
    error("Model name is required (e.g. ignex model User).");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(root);
  const modelsDir = resolveDir(root, parsed.dir, config.modelsDir, "src/models");

  let fields: ModelField[];
  try {
    fields = parseModelFields(parsed.fields);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return;
  }
  const plural = pluralize(name);
  const filePath = join(modelsDir, `${plural}.ts`);

  step(`Creating model ${name} (collection "${plural}")`);
  await writeScaffold(filePath, modelTemplate(name, fields), {
    force: parsed.force === true,
    overwrite: true,
  });

  // The generated model imports @ignex/ninox — make sure it's installed.
  await ensureDeps(root, ["@ignex/ninox"]);
}

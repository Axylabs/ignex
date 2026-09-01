/**
 * @fileoverview `ignex factory <Name>` — scaffold a test-data factory for a
 * ninox model.
 *
 *   ignex factory User --fields "email:string(format email),role:enum(admin,editor)"
 *
 * Writes `src/factories/<plural>.ts` with a typed `make<Model>()` factory that
 * generates randomized field values (per the model field DSL). The factory
 * imports the model's schema type so the return type is `InferDoc`-compatible,
 * and wires into `ignex seed` via a generated `seedFactories` helper.
 */
import { join } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import { factoryTemplate } from "../templates/factory.js";
import { type ModelField, parseModelFields, pluralize } from "../templates/model.js";
import { loadConfig } from "../utils/config.js";
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
  dir: { type: "string", valueHint: "dir", description: "Override the factories directory" },
  fields: {
    type: "string",
    valueHint: "list",
    description: "Comma-separated fields (same DSL as ignex model)",
  },
  force: { type: "boolean", description: "Overwrite an existing factory" },
} satisfies ArgsDef;

export const factoryCmd = defineCommand({
  meta: metaFor("factory"),
  args: argsDef,
  async run(ctx) {
    await runFactory(ctx.rawArgs);
  },
});

export default factoryCmd;

/** Run `ignex factory`. */
export async function runFactory(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);

  // The first positional is the model *name*, not a root path.
  const root = await resolveProjectRoot(parsed.root);
  const name = parsed.name;
  if (!name) {
    error("Model name is required (e.g. ignex factory User).");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(root);
  const factoriesDir = resolveDir(root, parsed.dir, config.factoriesDir, "src/factories");

  let fields: ModelField[];
  try {
    fields = parseModelFields(parsed.fields);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return;
  }
  const plural = pluralize(name);
  const filePath = join(factoriesDir, `${plural}.ts`);

  step(`Creating factory for ${name} (src/factories/${plural}.ts)`);
  await writeScaffold(filePath, factoryTemplate(name, fields), {
    force: parsed.force === true,
    overwrite: true,
  });
}

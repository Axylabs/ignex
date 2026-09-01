/**
 * `ignex hook <name>` — scaffold a hook file.
 *
 *   ignex hook require-admin            → src/hooks/require-admin.ts (named
 *                                         per-route hook, default export)
 *   ignex hook request-id --global      → src/hooks/request-id.ts (named export)
 *                                         + registered on `lifecycle.beforeHandle`
 *                                         in src/app.config.ts
 *   ignex hook log --global --stage afterHandle
 *
 * `--global` registers the hook into the app config's `lifecycle` export so it
 * runs on EVERY request (the compiler merges `plugins` + `lifecycle` from
 * `app.config.ts` into the generated server).
 */
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import { globalHookTemplate, namedHookTemplate } from "../templates/hook.js";
import { bunWriteFile } from "../utils/bun-compat.js";
import { loadConfig } from "../utils/config.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { exists, writeFileEnsuringDir } from "../utils/fs.js";
import { error, info, step, success, warn } from "../utils/logger.js";
import { resolveDir, writeScaffold } from "../utils/scaffold.js";
import { metaFor } from "./registry.js";

/** Lifecycle stages a global hook may be registered on (mirrors `LifeCycleStore`). */
export const GLOBAL_STAGES = [
  "start",
  "request",
  "parse",
  "transform",
  "beforeHandle",
  "afterHandle",
  "mapResponse",
  "afterResponse",
  "trace",
  "error",
] as const;

export interface ConfigMergeResult {
  content: string;
  added: boolean;
}

/**
 * Add a global hook import + lifecycle stage entry to an app-config source.
 *
 * Pure string transform — callers own file IO. Appends to an existing stage
 * array when present, adds the stage when absent, and never duplicates a hook
 * already registered on the stage. Used by `ignex hook --global`.
 */
export const addGlobalHookToConfig = (
  content: string,
  name: string,
  stage: string,
): ConfigMergeResult => {
  const importLine = `import { ${name} } from "./hooks/${name}.js";`;

  const next = content.includes(importLine) ? content : insertImport(content, importLine);

  const lifecycle = /export const lifecycle\s*=\s*\{([\s\S]*?)\};/.exec(next);

  if (!lifecycle) {
    return {
      content: `${next.trimEnd()}\n\nexport const lifecycle = {\n  ${stage}: [${name}]\n};\n`,
      added: true,
    };
  }

  const body = lifecycle[1] ?? "";
  const stageArray = new RegExp(`\\b${stage}\\s*:\\s*\\[([^\\]]*)\\]`).exec(body);

  if (stageArray) {
    const members = stageArray[1] ?? "";
    if (new RegExp(`\\b${name}\\b`).test(members)) {
      return { content: next, added: false };
    }
    // Append to the existing stage array: `[a]` → `[a, name]`.
    const insert = members.trim() === "" ? `${name}` : `${members.trimEnd()}, ${name}`;
    const patchedBody = body.replace(stageArray[0], `${stage}: [${insert}]`);
    return {
      content: next.replace(lifecycle[0], `export const lifecycle = {${patchedBody}};`),
      added: true,
    };
  }

  // Stage absent — insert it into the lifecycle body (after the opening brace).
  return {
    content: next.replace(/export const lifecycle\s*=\s*\{/, (m) => `${m}\n  ${stage}: [${name}],`),
    added: true,
  };
};

/** Insert an import line after the last existing import (or at the top). */
const insertImport = (content: string, importLine: string): string => {
  const importLines = content.match(/^import .*$/gm) ?? [];
  const lastImport = importLines[importLines.length - 1];
  if (lastImport) {
    return content.replace(lastImport, `${lastImport}\n${importLine}`);
  }
  return `${importLine}\n${content}`;
};

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  name: {
    type: "positional",
    required: false,
    description: "Hook name in kebab-case (e.g. require-admin)",
  },
  root: { type: "string", valueHint: "dir", description: "Project root" },
  global: {
    type: "boolean",
    description: "Register the hook as a global lifecycle hook (app.config lifecycle)",
  },
  stage: {
    type: "string",
    valueHint: "beforeHandle|afterHandle|afterResponse|error|...",
    description: "Lifecycle stage for --global (default beforeHandle)",
  },
  force: { type: "boolean", description: "Overwrite an existing hook file" },
} satisfies ArgsDef;

export const hookCmd = defineCommand({
  meta: metaFor("hook"),
  args: argsDef,
  async run(ctx) {
    await runHook(ctx.rawArgs);
  },
});

export default hookCmd;

export async function runHook(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);

  const root = await resolveProjectRoot(parsed.root);
  const name = parsed.name;
  if (!name) {
    error("Hook name is required (e.g. ignex hook require-admin).");
    process.exitCode = 1;
    return;
  }
  const isGlobal = parsed.global === true;
  const stage = parsed.stage ?? "beforeHandle";
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    error(
      `Invalid hook name "${name}" — use a valid JS identifier (e.g. require-admin → requireAdmin).`,
    );
    process.exitCode = 1;
    return;
  }
  if (isGlobal && !(GLOBAL_STAGES as readonly string[]).includes(stage)) {
    error(`Invalid --stage "${stage}". Valid stages: ${GLOBAL_STAGES.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(root);
  const hooksDir = resolveDir(root, undefined, config.hooksDir, "src/hooks");
  const hookPath = join(hooksDir, `${name}.ts`);

  step(
    isGlobal
      ? `Scaffolding global hook ${name} (${stage} stage)`
      : `Scaffolding named hook ${name}`,
  );
  if (
    !(await writeScaffold(hookPath, isGlobal ? globalHookTemplate(name) : namedHookTemplate(name), {
      force: parsed.force === true,
      overwrite: true,
    }))
  ) {
    return;
  }

  if (isGlobal) {
    await registerGlobalHook(root, name, stage);
  } else {
    info(`Reference it from a route: export const config = { hooks: ["${name}"] };`);
  }
}

/** Register a global hook into `src/app.config.ts`'s `lifecycle` export. */
async function registerGlobalHook(root: string, name: string, stage: string): Promise<void> {
  const appConfigPath = join(root, "src", "app.config.ts");

  if (!(await exists(appConfigPath))) {
    const { content } = addGlobalHookToConfig("", name, stage);
    await writeFileEnsuringDir(appConfigPath, content);
    success(`Created ${relative(process.cwd(), appConfigPath)} (lifecycle.${stage})`);
    return;
  }

  const source = await readFile(appConfigPath, "utf8");
  const { content, added } = addGlobalHookToConfig(source, name, stage);

  if (!added) {
    warn(`lifecycle.${stage} already exists — ${name} was not registered.`);
    return;
  }

  await bunWriteFile(appConfigPath, content);
  success(`Registered ${name} on lifecycle.${stage} in ${relative(process.cwd(), appConfigPath)}`);
}

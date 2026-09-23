/**
 * @fileoverview Additive merge into an existing `src/plugins/index.ts`.
 *
 * `ignex add cors` writes the plugins module; a later `ignex add security`
 * must EXTEND it rather than skip it (the file already exists) or overwrite it
 * (which would drop a hand-added plugin). The merge is a conservative TEXT
 * edit: new factory names are added to the existing `@ignex/core` import and
 * their `name()` calls are prepended to the `plugins` array, preserving every
 * existing entry and its formatting. Unrecognizable source is left untouched
 * (`added: []`) so the caller can fall back to a manual hint.
 */

/** The `@ignex/core` import that carries the plugin factories. */
const CORE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"@ignex\/core";/;

/** The generated `plugins` array (optionally annotated, e.g. `: never[]`). */
const PLUGINS_ARRAY = /export const plugins\s*(?::[^=]*)?=\s*\[([\s\S]*?)\];/;

/** Factory names already called inside a `plugins` array body. */
const pluginCalls = (body: string): string[] =>
  [...body.matchAll(/\b([A-Za-z_$][\w$]*)\(\)/g)].map((match) => match[1] ?? "");

/** Split an import specifier list into trimmed, non-empty names. */
const splitNames = (specifiers: string | undefined): string[] =>
  (specifiers ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

/** Outcome of {@link addPluginsToModule}. */
export interface PluginsModuleMergeResult {
  /** The (possibly modified) source text. */
  content: string;
  /** Factory names that were added (empty when already present/unmergeable). */
  added: string[];
}

/**
 * Add plugin factories to a `src/plugins/index.ts` source.
 *
 * @param source - The current module source.
 * @param names - Plugin factory names to ensure are registered (e.g. `cors`).
 * @returns The patched source and the names that were actually added.
 */
export function addPluginsToModule(
  source: string,
  names: readonly string[],
): PluginsModuleMergeResult {
  const block = PLUGINS_ARRAY.exec(source);
  if (!block) return { content: source, added: [] };

  const present = pluginCalls(block[1] ?? "");
  const missing = names.filter((name) => !present.includes(name));
  if (missing.length === 0) return { content: source, added: [] };

  // 1. Merge the factories into the existing @ignex/core import (or add one).
  let content = source;
  const imp = CORE_IMPORT.exec(content);
  if (imp) {
    const merged = [...new Set([...splitNames(imp[1]), ...missing])].sort();
    content = content.replace(imp[0], () => `import { ${merged.join(", ")} } from "@ignex/core";`);
  } else {
    content = `import { ${[...missing].sort().join(", ")} } from "@ignex/core";\n\n${content}`;
  }

  // 2. Prepend the new `name()` entries to the plugins array.
  const target = PLUGINS_ARRAY.exec(content);
  if (target) {
    const body = (target[1] ?? "").replace(/^\n/, "");
    const prefix = missing.map((name) => `  ${name}(),\n`).join("");
    content = content.replace(target[0], () => `export const plugins = [\n${prefix}${body}];`);
  }

  return { content, added: missing };
}

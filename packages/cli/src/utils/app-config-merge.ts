/**
 * @fileoverview Conservative, additive `ignex add` wiring for app config.
 */

/** The `src/app.config.ts` edits an install plan needs. */
export interface AppConfigWiringOptions {
  /** Spread `...appPlugins` (from `src/plugins/index.ts`) into `plugins`. */
  plugins?: boolean;
  /** Spread `...middleware` (from `src/middleware/index.ts`) into `plugins`. */
  middleware?: boolean;
}

/** Outcome of {@link wireAppConfig}. */
export interface AppConfigWiringResult {
  /** The (possibly modified) source text. */
  content: string;
  /** One-line notes for each edit applied (empty when already wired). */
  changes: string[];
  /** `false` when no `export const plugins = […]` array was found. */
  patchedPluginsArray: boolean;
}

const PLUGINS_IMPORT = 'import { plugins as appPlugins } from "./plugins/index.js";';
const MIDDLEWARE_IMPORT = 'import { middleware } from "./middleware/index.js";';
const PLUGINS_ARRAY = /export const plugins\s*=\s*\[([\s\S]*?)\];/;

/**
 * Insert an import after the last single-line import, or at the module start.
 * Existing imports are never duplicated.
 */
export function insertImportLine(content: string, line: string): string {
  const importLines = content.match(/^import .*$/gm) ?? [];
  const last = importLines[importLines.length - 1];
  if (last !== undefined) return content.replace(last, () => `${last}\n${line}`);
  return `${line}\n${content}`;
}

/**
 * Add missing bundle imports and plugin-array spreads without changing any
 * user-defined lifecycle configuration. Unrecognized modules are left intact.
 */
export function wireAppConfig(
  source: string,
  options: AppConfigWiringOptions = {},
): AppConfigWiringResult {
  let content = source;
  const changes: string[] = [];
  const imports: string[] = [];
  const spreads: string[] = [];

  const block = PLUGINS_ARRAY.exec(source);
  const canSpread = block !== null;
  if (options.plugins && canSpread) {
    imports.push(PLUGINS_IMPORT);
    spreads.push("...appPlugins,");
  }
  if (options.middleware && canSpread) {
    imports.push(MIDDLEWARE_IMPORT);
    spreads.push("...middleware,");
  }

  let addedImports = 0;
  for (const line of imports) {
    if (content.includes(line)) continue;
    content = insertImportLine(content, line);
    addedImports++;
  }
  if (addedImports > 0) changes.push(addedImports === 1 ? "1 import" : `${addedImports} imports`);

  if (block) {
    const body = block[1] ?? "";
    const missing = spreads.filter((spread) => !body.includes(spread));
    if (missing.length > 0) {
      const prefix = `\n${missing.map((spread) => `  ${spread}`).join("\n")}\n`;
      const rest = body.startsWith("\n") ? body.replace(/^\n/, "") : `  ${body.trim()}\n`;
      content = content.replace(block[0], () => `export const plugins = [${prefix}${rest}];`);
      changes.push(...missing.map((spread) => `plugins ${spread.replace(/,$/, "")}`));
    }
  }

  return { content, changes, patchedPluginsArray: canSpread };
}

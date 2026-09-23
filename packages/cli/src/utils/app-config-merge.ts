/**
 * @fileoverview Additive wiring of `ignex add` bundles into `src/app.config.ts`.
 *
 * `ignex create` *generates* an app config with the selected plugins and
 * middleware already spread into its `plugins` array. `ignex add` has to reach
 * the same end state on a file the user may already have edited, so this
 * module performs a conservative TEXT edit:
 *
 *   - add the missing `import …` lines (never duplicates an existing import),
 *   - prepend the missing `...appPlugins` / `...middleware` spreads to the
 *     `plugins` array,
 *   - add or extend `export const lifecycle` with the example `beforeHandle`
 *     hooks (`logRequests()`, `markResponse()`) — never a second
 *     `export const lifecycle`, which would be a duplicate-export error.
 *
 * When the expected structure is not recognizable it refuses to touch that
 * part and reports it (`patchedPluginsArray: false`) rather than corrupting
 * user code; the caller prints the manual step instead.
 */

/** The `src/app.config.ts` edits an install plan needs. */
export interface AppConfigWiringOptions {
  /** Spread `...appPlugins` (from `src/plugins/index.ts`) into `plugins`. */
  plugins?: boolean;
  /** Spread `...middleware` and register the example `beforeHandle` hooks. */
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

/** Import lines added for the plugins / middleware bundles. */
const PLUGINS_IMPORT = 'import { plugins as appPlugins } from "./plugins/index.js";';
const MIDDLEWARE_IMPORT = 'import { middleware } from "./middleware/index.js";';
const HOOKS_IMPORT = 'import { logRequests, markResponse } from "./middleware/log-requests.js";';

/** The example `beforeHandle` hooks the middleware bundle registers. */
const HOOK_MEMBERS = "logRequests(), markResponse()";

/** The generated `plugins` array (`export const plugins = [ … ];`). */
const PLUGINS_ARRAY = /export const plugins\s*=\s*\[([\s\S]*?)\];/;

/** The generated `lifecycle` export, if the app already declares one. */
const LIFECYCLE_BLOCK = /export const lifecycle\s*=\s*\{([\s\S]*?)\n?\};/;

/**
 * Insert an import line after the last existing import (or at the top).
 *
 * @param content - Source text to patch.
 * @param line - The whole import statement to insert.
 * @returns The source with {@link line} present exactly once.
 */
export function insertImportLine(content: string, line: string): string {
  const importLines = content.match(/^import .*$/gm) ?? [];
  const last = importLines[importLines.length - 1];
  if (last !== undefined) return content.replace(last, () => `${last}\n${line}`);
  return `${line}\n${content}`;
}

/** True when the lifecycle already registers the example hooks. */
const hasExampleHooks = (content: string): boolean => content.includes("logRequests()");

/**
 * Add (or extend) `export const lifecycle` with the middleware example hooks.
 *
 * @param content - Source text to patch.
 * @returns The patched source and whether anything was added.
 */
const addMiddlewareLifecycle = (content: string): { content: string; added: boolean } => {
  const block = LIFECYCLE_BLOCK.exec(content);
  if (!block) {
    return {
      content: `${content.trimEnd()}\n\nexport const lifecycle = {\n  beforeHandle: [${HOOK_MEMBERS}]\n};\n`,
      added: true,
    };
  }

  const body = block[1] ?? "";
  if (hasExampleHooks(body)) return { content, added: false };

  const stage = /\bbeforeHandle\s*:\s*\[([^\]]*)\]/.exec(body);
  if (stage) {
    const members = (stage[1] ?? "").trim();
    const insert = members === "" ? HOOK_MEMBERS : `${members}, ${HOOK_MEMBERS}`;
    const patched = body.replace(stage[0], () => `beforeHandle: [${insert}]`);
    return {
      content: content.replace(block[0], () => `export const lifecycle = {${patched}};`),
      added: true,
    };
  }

  // Lifecycle exists but has no `beforeHandle` stage yet — insert one.
  return {
    content: content.replace(
      /export const lifecycle\s*=\s*\{/,
      (m) => `${m}\n  beforeHandle: [${HOOK_MEMBERS}],`,
    ),
    added: true,
  };
};

/**
 * Wire the requested bundles into an `src/app.config.ts` source.
 *
 * Idempotent: re-running with the same options reports no changes. Pure —
 * callers own all file IO. Each section is independent: a missing
 * `export const plugins = […]` array only blocks the array spreads (reported
 * through `patchedPluginsArray`), never the lifecycle hooks.
 *
 * @param source - The current app-config source text.
 * @param options - Which bundles to wire (see {@link AppConfigWiringOptions}).
 * @returns The patched source, a summary of edits, and whether the plugins
 *   array was recognizable.
 */
export function wireAppConfig(
  source: string,
  options: AppConfigWiringOptions = {},
): AppConfigWiringResult {
  let content = source;
  const changes: string[] = [];
  const imports: string[] = [];
  const spreads: string[] = [];

  // Both bundles are spread INTO the plugins array, so they need it to exist.
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

  const addingHooks = options.middleware === true && !hasExampleHooks(source);
  if (addingHooks) imports.push(HOOKS_IMPORT);

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
      // Keep the existing formatting: only the body's first newline is
      // consumed (an inline `[a()]` body keeps its entry, re-indented).
      const rest = body.startsWith("\n") ? body.replace(/^\n/, "") : `  ${body.trim()}\n`;
      content = content.replace(block[0], () => `export const plugins = [${prefix}${rest}];`);
      changes.push(...missing.map((spread) => `plugins ${spread.replace(/,$/, "")}`));
    }
  }

  if (addingHooks) {
    const lifecycle = addMiddlewareLifecycle(content);
    if (lifecycle.added) {
      content = lifecycle.content;
      changes.push("lifecycle.beforeHandle hooks");
    }
  }

  return { content, changes, patchedPluginsArray: canSpread };
}

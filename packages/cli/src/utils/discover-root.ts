/**
 * @fileoverview Smart project-root discovery.
 *
 * Commands that operate on "the app" (`dev`, `build`, `route:list`, `doctor`,
 * …) accept `--root`, but requiring it from a subdirectory is friction. When
 * no explicit root is given, `discoverRoot` walks up from the starting
 * directory looking for ignex project markers:
 *
 *   1. an `ignex.config.{ts,mts,mjs,js,json}` file
 *   2. a routes directory at the conventional `src/routes` location
 *   3. a `.ignex/` compiler output directory
 *
 * The walk stops at the filesystem root; with no marker found it returns the
 * fallback (the starting directory), matching the historical behavior.
 */

import { dirname, join, resolve } from "node:path";
import { CONFIG_FILES } from "./config.js";
import { exists } from "./fs.js";

/** How many directory levels to walk up before giving up. */
export const MAX_WALK_UP = 8;

/** Returns true when `dir` looks like an ignex project root. */
export async function looksLikeProjectRoot(dir: string): Promise<boolean> {
  for (const file of CONFIG_FILES) {
    if (await exists(join(dir, file))) return true;
  }
  return (await exists(join(dir, "src", "routes"))) || (await exists(join(dir, ".ignex")));
}

/**
 * Walk up from `from` to find the nearest ignex project root.
 *
 * @param from - Directory to start from (default cwd).
 * @returns Absolute path of the detected project root, or `undefined`.
 */
export async function findProjectRoot(from: string = process.cwd()): Promise<string | undefined> {
  let current = resolve(from);

  for (let depth = 0; depth < MAX_WALK_UP; depth++) {
    if (await looksLikeProjectRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }

  return undefined;
}

/**
 * Resolve the effective project root for a project-scoped command.
 *
 * Precedence: explicit `--root` → walk-up discovery → `fallback` (cwd).
 * Discovery never overrides an explicit root, so scripts keep working.
 *
 * @param explicitRoot - Value of `--root`, when provided.
 * @param fallback - Directory used when nothing is discovered (default cwd).
 */
export async function resolveProjectRoot(
  explicitRoot: string | undefined,
  fallback: string = process.cwd(),
): Promise<string> {
  if (explicitRoot) return resolve(explicitRoot);
  return (await findProjectRoot(fallback)) ?? resolve(fallback);
}

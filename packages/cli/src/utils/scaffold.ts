/**
 * Shared scaffold helpers for the `ignex model|resource|hotroute|route|hook`
 * commands. Centralizes the flows each command previously inlined:
 *   - resolving a target directory (`--dir` override → config → default),
 *   - requiring the first positional (name/path) with the shared error,
 *   - writing a file behind the exists/`--force` gate with the shared
 *     "already exists. Use --force to overwrite." error + `Created` message.
 */
import { relative, resolve } from "node:path";
import { exists, writeFileEnsuringDir } from "./fs.js";
import { error, success } from "./logger.js";

/** Options for {@link writeScaffold}. */
export interface ScaffoldWriteOptions {
  /** Overwrite an existing file (default `false`). */
  force?: boolean;
  /**
   * When the file exists and `force` is `false`: log the shared error and set
   * `process.exitCode = 1` (the blocking scaffold contract). When `false` the
   * skip is silent — used by multi-file template loops that should just move
   * on. Default `false` (silent skip).
   */
  overwrite?: boolean;
}

/**
 * Write one scaffolded file behind the standard exists/`--force` gate.
 *
 * Returns `true` when the file was written, `false` when it was skipped.
 * On a blocking conflict (`overwrite: true`) an error is logged and
 * `process.exitCode` is set to `1` — the commands' existing contract.
 */
export async function writeScaffold(
  path: string,
  content: string,
  options: ScaffoldWriteOptions = {},
): Promise<boolean> {
  const { force = false, overwrite = false } = options;
  if ((await exists(path)) && !force) {
    if (overwrite) {
      error(`${relative(process.cwd(), path)} already exists. Use --force to overwrite.`);
      process.exitCode = 1;
    }
    return false;
  }
  await writeFileEnsuringDir(path, content);
  success(`Created ${relative(process.cwd(), path)}`);
  return true;
}

/**
 * Take the first positional, or log `message` + set `process.exitCode = 1`
 * and return `""`. The shared "a name is required" guard.
 */
export function firstPositional(positionals: readonly string[], message: string): string {
  const value = positionals[0];
  if (!value) {
    error(message);
    process.exitCode = 1;
    return "";
  }
  return value;
}

/**
 * Resolve a scaffold target directory: `--dir` override → configured value →
 * default. `configured` is a value from the loaded app config (e.g.
 * `modelsDir`, `routesDir`, `hooksDir`).
 */
export function resolveDir(
  root: string,
  dirOverride: unknown,
  configured: unknown,
  fallback: string,
): string {
  return resolve(
    root,
    (dirOverride as string | undefined) ?? (typeof configured === "string" ? configured : fallback),
  );
}

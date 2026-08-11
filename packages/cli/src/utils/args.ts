/**
 * @fileoverview Shared CLI argument helpers.
 *
 * `parseCliArgs` centralizes the `node:util` `parseArgs` boilerplate every
 * command repeats (allowPositionals + strict:false); `resolveRoot` centralizes
 * the `--root` → first positional → cwd resolution chain.
 */

import { resolve } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";

type ParseArgsResult = ReturnType<typeof parseArgs>;

/**
 * Parse command args with the common CLI conventions (positionals allowed,
 * unknown flags ignored).
 */
export const parseCliArgs = (
  args: string[],
  options: NonNullable<ParseArgsConfig["options"]>,
): ParseArgsResult => parseArgs({ args, options, allowPositionals: true, strict: false });

/** Resolve the project root from `--root`, the first positional, or cwd. */
export const resolveRoot = (
  values: Record<string, unknown>,
  positionals: readonly string[],
  fallback = ".",
): string => resolve((values.root as string | undefined) ?? positionals[0] ?? fallback);

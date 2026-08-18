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

export interface ResolveRootOptions {
  /**
   * Commands whose first positional is a *name* rather than a path — e.g.
   * `ignex resource User`, `ignex model User`, `ignex route health.get` —
   * must not let that name hijack the project root. Set this to skip
   * positionals and fall back to `--root` then cwd.
   */
  ignorePositionals?: boolean;
}

/** Resolve the project root from `--root`, the first positional, or cwd. */
export const resolveRoot = (
  values: Record<string, unknown>,
  positionals: readonly string[],
  options: ResolveRootOptions = {},
): string =>
  resolve(
    (values.root as string | undefined) ??
      (options.ignorePositionals ? undefined : positionals[0]) ??
      ".",
  );

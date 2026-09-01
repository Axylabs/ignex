/**
 * @fileoverview Shared adapter for running a citty command definition from a
 * raw argv array.
 *
 * Every command exports its `defineCommand` definition as the default export
 * (consumed by the root app) plus a legacy-named `runX(argv)` entry that tests
 * and internal delegations call directly. Both paths share this helper so
 * parsing semantics are identical everywhere.
 */

import { type ArgsDef, type CommandDef, runCommand } from "citty";

/**
 * Parse `argv` against `cmd`'s typed args and invoke its `run`.
 *
 * Generic over the command's args so typed definitions (whose `setup`/`run`
 * close over their own `CommandContext<T>`) stay assignable — a bare
 * `CommandDef` (defaulting to `CommandDef<ArgsDef>`) rejects them.
 *
 * @param cmd - The citty command definition.
 * @param argv - Raw argument strings (flags + positionals).
 */
export const runDef = async <T extends ArgsDef>(
  cmd: CommandDef<T>,
  argv: string[],
): Promise<void> => {
  await runCommand(cmd, { rawArgs: argv });
};

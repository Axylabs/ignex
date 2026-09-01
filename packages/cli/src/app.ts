/**
 * @fileoverview The root citty application.
 *
 * `ignexApp` declares every command as a lazily-loaded subcommand (see
 * `commands/loaders.ts`) with `help` as the default, so:
 *
 *   ignex               → root help (branded, grouped)
 *   ignex help <cmd>    → per-command help (+ curated examples)
 *   ignex <cmd> --help  → same, via citty's builtin help flag
 *
 * Command implementations are never imported at module scope — startup cost
 * stays flat no matter how many commands exist.
 */

import { defineCommand, type SubCommandsDef } from "citty";
import { loaders } from "./commands/loaders.js";
import { commands } from "./commands/registry.js";
import { cliVersion } from "./version.js";

const subCommands: SubCommandsDef = Object.fromEntries(
  commands.flatMap((row) => {
    const loader = loaders[row.name];
    if (!loader) return [];
    return [[row.name, () => loader().then((mod) => mod.default)]];
  }),
);

/** The root command — dispatch only; all parsing belongs to subcommands. */
export const ignexApp = defineCommand({
  meta: {
    name: "ignex",
    version: cliVersion(),
    description: "The ignex developer CLI — scaffold, develop, and ship Bun-first apps",
  },
  args: {},
  default: "help",
  subCommands,
});

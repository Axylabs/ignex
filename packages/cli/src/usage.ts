/**
 * @fileoverview Per-command help rendering.
 *
 * Wraps citty's auto-generated usage (built from each command's typed args —
 * always in sync with actual parsing) and appends the registry's curated
 * EXAMPLES section, so every command documents real invocations.
 */

import { type ArgsDef, type CommandDef, type CommandMeta, renderUsage } from "citty";
import { renderRootHelp } from "./commands/registry.js";
import { bold, cyan } from "./utils/logger.js";

/** Resolve citty meta regardless of whether it was declared as a value/function/promise. */
async function resolveMeta<T extends ArgsDef = ArgsDef>(
  cmd: CommandDef<T>,
): Promise<CommandMeta | undefined> {
  const meta = (cmd as CommandDef).meta as
    | CommandMeta
    | (() => CommandMeta | Promise<CommandMeta>)
    | undefined;
  if (typeof meta === "function") return await meta();
  return await meta;
}

/**
 * Render full help for one command: citty USAGE/ARGUMENTS/OPTIONS plus an
 * EXAMPLES section sourced from the registry row.
 */
export async function renderCommandHelp<T extends ArgsDef = ArgsDef>(
  cmd: CommandDef<T>,
): Promise<string> {
  // citty's own helpers are unparameterized (`CommandDef<ArgsDef>`); a typed
  // definition is structurally compatible, so widen at the call boundary.
  const usage = await renderUsage(cmd as CommandDef);
  const meta = await resolveMeta(cmd);
  const examples = (meta as { examples?: readonly string[] } | undefined)?.examples;
  if (!examples || examples.length === 0) return usage;

  return [
    usage,
    `${bold("EXAMPLES")}`,
    "",
    ...examples.map((example) => `  ${cyan("$")} ${example}`),
  ].join("\n");
}

/** `runMain` showUsage override: branded root help + enriched per-command help. */
export async function showUsage<T extends ArgsDef = ArgsDef>(
  cmd: CommandDef<T>,
  parent?: CommandDef<T>,
): Promise<void> {
  if (!parent) {
    console.log(renderRootHelp());
    return;
  }
  console.log(`${await renderCommandHelp(cmd)}\n`);
}

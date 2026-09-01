/**
 * @fileoverview CLI entry: dispatch `argv` into the citty root app.
 *
 * Before handing off to citty, an unknown first token is intercepted to print
 * a friendly "did you mean" list (citty's own unknown-command error is a
 * backstop). Everything else — `--help`/`-h` anywhere, `--version`/`-v`,
 * subcommand dispatch, per-command parsing — is citty.
 *
 * @param argv - Arguments after the binary name (`process.argv.slice(2)`).
 */

import { pathToFileURL } from "node:url";
import { runMain } from "citty";
import { ignexApp } from "./app.js";
import { commandNames, findCommand, renderGroupedCommands } from "./commands/registry.js";
import { showUsage } from "./usage.js";
import { bold, cyan, dim } from "./utils/logger.js";
import { suggest } from "./utils/suggest.js";
import { cliVersion } from "./version.js";

/** Print the branded help for an unrecognized command + close matches. */
function printUnknownCommand(input: string): void {
  const matches = suggest(input, commandNames());
  console.error(`Unknown command: ${bold(input)}\n`);
  if (matches.length > 0) {
    console.log(`Did you mean:\n`);
    for (const match of matches) {
      const row = findCommand(match);
      console.log(
        `  ${cyan("ignex")} ${cyan(bold(match))}${row ? dim(` — ${row.description}`) : ""}`,
      );
    }
    console.log();
  }
  console.log(renderGroupedCommands());
  console.log(`\n${dim(`Run ${cyan("ignex --help")} for usage.`)}`);
}

/**
 * Run the ignex CLI.
 *
 * @param argv - Raw arguments (without the binary name).
 */
export async function main(argv: string[]): Promise<void> {
  const head = argv[0];

  // Legacy word-form version flag (kept for scripts; citty handles -v/--version).
  if (head === "version") {
    console.log(cliVersion());
    return;
  }

  // Friendly typo recovery before dispatching into citty.
  if (head && !head.startsWith("-") && !findCommand(head)) {
    printUnknownCommand(head);
    process.exitCode = 1;
    return;
  }

  await runMain(ignexApp, { rawArgs: argv, showUsage });
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

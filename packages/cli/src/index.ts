import { pathToFileURL } from "node:url";
import { findCommand, renderCommandHelp, renderHelp } from "./commands/registry.js";
import { cliVersion } from "./version.js";

/**
 * CLI entry: dispatch `argv` to the matching command (or print help).
 *
 * `--version` prints the CLI version; `ignex <command> --help` prints that
 * command's flag reference; unknown commands print help and set a non-zero
 * exit code. Each command's `run` is awaited so errors propagate to the
 * bin-level catch.
 *
 * @param argv - Arguments after the binary name (`process.argv.slice(2)`).
 */
export async function main(argv: string[]): Promise<void> {
  const [commandName, ...rest] = argv;

  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    console.log(renderHelp().trim());
    return;
  }

  if (commandName === "--version" || commandName === "-v" || commandName === "version") {
    console.log(cliVersion());
    return;
  }

  const command = findCommand(commandName);

  if (!command) {
    console.error(`Unknown command: ${commandName}\n`);
    console.log(renderHelp().trim());
    process.exitCode = 1;
    return;
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(renderCommandHelp(command).trim());
    return;
  }

  await command.run(rest);
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

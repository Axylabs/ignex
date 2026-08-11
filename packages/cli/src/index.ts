import { pathToFileURL } from "node:url";
import { findCommand, renderHelp } from "./commands/registry.js";

export async function main(argv: string[]): Promise<void> {
  const [commandName, ...rest] = argv;

  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    console.log(renderHelp().trim());
    return;
  }

  const command = findCommand(commandName);

  if (!command) {
    console.error(`Unknown command: ${commandName}\n`);
    console.log(renderHelp().trim());
    process.exitCode = 1;
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

/**
 * @fileoverview `ignex help [command]` — the default subcommand.
 *
 * Bare `ignex` resolves here (root `default: "help"`), printing the branded
 * grouped help; `ignex help <command>` loads that command and renders its
 * auto-generated usage plus curated examples.
 */

import { type CommandDef, defineCommand } from "citty";
import { renderCommandHelp } from "../usage.js";
import { yellow } from "../utils/logger.js";
import { loadCommand } from "./loaders.js";
import { findCommand, renderRootHelp } from "./registry.js";

export const helpCmd = defineCommand({
  meta: {
    name: "help",
    description: "Show help for ignex or a specific command",
  },
  args: {
    command: {
      type: "positional",
      required: false,
      description: "Command to explain (e.g. dev, resource, ops)",
    },
  },
  async run({ args }) {
    const name = args.command;
    if (!name) {
      console.log(renderRootHelp());
      return;
    }

    if (!findCommand(name)) {
      console.error(`${yellow("⚠")} Unknown command: ${name}`);
      process.exitCode = 1;
      return;
    }

    const cmd = (await loadCommand(name)) as CommandDef | undefined;
    if (!cmd) {
      console.log(renderRootHelp());
      return;
    }

    console.log(`${await renderCommandHelp(cmd)}\n`);
  },
});

export default helpCmd;

/**
 * `ignex completions <shell>` — print a shell completion script to stdout.
 *
 * Supported shells are `bash`, `zsh`, `fish`, `powershell` and `cmd`. Pipe or
 * source the output to enable tab-completion (each script carries install
 * instructions in its header). `cmd` prints a clink Lua script, since cmd.exe
 * has no native completion hook.
 */
import { defineCommand } from "citty";
import { bashCompletionScript } from "../completions/bash.js";
import { cmdCompletionScript } from "../completions/cmd.js";
import { fishCompletionScript } from "../completions/fish.js";
import { powershellCompletionScript } from "../completions/powershell.js";
import { zshCompletionScript } from "../completions/zsh.js";
import { COMPLETION_SHELLS } from "../utils/completion.js";
import { error } from "../utils/logger.js";
import { runDef } from "../utils/run-def.js";
import { metaFor } from "./registry.js";

const SHELL_SCRIPTS: Record<(typeof COMPLETION_SHELLS)[number], string> = {
  bash: bashCompletionScript,
  zsh: zshCompletionScript,
  fish: fishCompletionScript,
  powershell: powershellCompletionScript,
  cmd: cmdCompletionScript,
};

export const completionsCmd = defineCommand({
  meta: metaFor("completions"),
  args: {
    shell: {
      type: "positional",
      required: false,
      description: "Shell name (bash, zsh, fish, powershell, cmd)",
    },
  },
  async run({ args }) {
    const shell = args.shell;

    if (!shell || !(shell in SHELL_SCRIPTS)) {
      error(
        `Unknown shell: ${shell ?? "(none provided)"}. Supported: ${COMPLETION_SHELLS.join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(SHELL_SCRIPTS[shell as keyof typeof SHELL_SCRIPTS]);
  },
});

export default completionsCmd;

/** Back-compat entry: raw argv → parsed via citty. */
export const runCompletions = (args: string[]): Promise<void> => runDef(completionsCmd, args);

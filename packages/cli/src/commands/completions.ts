/**
 * `ignex completions <shell>` — print a shell completion script to stdout.
 *
 * Supported shells are `bash`, `zsh`, `fish`, `powershell` and `cmd`. Pipe or
 * source the output to enable tab-completion (each script carries install
 * instructions in its header). `cmd` prints a clink Lua script, since cmd.exe
 * has no native completion hook.
 */
import { bashCompletionScript } from "../completions/bash.js";
import { cmdCompletionScript } from "../completions/cmd.js";
import { fishCompletionScript } from "../completions/fish.js";
import { powershellCompletionScript } from "../completions/powershell.js";
import { zshCompletionScript } from "../completions/zsh.js";
import { parseCliArgs } from "../utils/args.js";
import { COMPLETION_SHELLS } from "../utils/completion.js";
import { error } from "../utils/logger.js";

const SHELL_SCRIPTS: Record<(typeof COMPLETION_SHELLS)[number], string> = {
  bash: bashCompletionScript,
  zsh: zshCompletionScript,
  fish: fishCompletionScript,
  powershell: powershellCompletionScript,
  cmd: cmdCompletionScript,
};

export async function runCompletions(args: string[]): Promise<void> {
  const { positionals } = parseCliArgs(args, {});
  const shell = positionals[0];

  if (!shell || !(shell in SHELL_SCRIPTS)) {
    error(
      `Unknown shell: ${shell ?? "(none provided)"}. Supported: ${COMPLETION_SHELLS.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(SHELL_SCRIPTS[shell as keyof typeof SHELL_SCRIPTS]);
}

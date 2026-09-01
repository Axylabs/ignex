/**
 * `ignex _complete` — the hidden shell-completion backend.
 *
 * Generated completion scripts (see `completions/`) call this with the live
 * command line and cursor offset:
 *
 *   ignex _complete --line "ignex create --runtime b" --cursor 24
 *
 * It prints newline-separated suggestions to stdout (nothing when there are
 * none, so the shell falls back to file completion). Kept out of help listings
 * via the `hidden` registry flag — `_complete` is an internal protocol, not a
 * user-facing command.
 *
 * The line may be given inline (`--line "..."`) or via a response file
 * (`--line @<path>`) — cmd/clink passes the raw line through a temp file so
 * shell quoting can never corrupt it.
 */
import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { type CompletableCommand, complete, flagsFromArgs } from "../utils/completion.js";
import { runDef } from "../utils/run-def.js";
import { loaders } from "./loaders.js";
import { commands } from "./registry.js";

/** Parse the `--cursor` value defensively (shells pass a decimal string). */
const parseCursor = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/** Resolve `--line` (inline or `@file` response file) into the command text. */
const resolveLine = async (raw: string): Promise<string> => {
  if (!raw.startsWith("@")) return raw;
  try {
    return (await readFile(raw.slice(1), "utf-8")).replace(/\r?\n$/, "");
  } catch {
    return "";
  }
};

/**
 * Load the completable command table: registry rows joined with each command's
 * typed args definition (flags + value candidates). Import cost is irrelevant
 * here — completions run rarely, and correctness beats startup for them.
 */
export async function loadCompletableCommands(): Promise<CompletableCommand[]> {
  return Promise.all(
    commands.map(async (row): Promise<CompletableCommand> => {
      const loader = loaders[row.name];
      if (!loader) {
        return { name: row.name, aliases: row.aliases, hidden: row.hidden, flags: [] };
      }
      const def = ((await loader()) as { default?: { args?: unknown } }).default;
      // The cast makes this non-nullable; `?? {}` here would be dead code.
      const args = (def?.args ?? {}) as Record<string, never>;
      return {
        name: row.name,
        aliases: row.aliases,
        hidden: row.hidden,
        flags: flagsFromArgs(args),
      };
    }),
  );
}

export const completeCmd = defineCommand({
  meta: { name: "_complete", hidden: true, description: "Shell-completion backend" },
  args: {
    line: { type: "string", description: "Full command line to complete" },
    cursor: { type: "string", valueHint: "offset", description: "Cursor offset into the line" },
  },
  async run({ args }) {
    const line = await resolveLine(args.line ?? "");
    const cursor = parseCursor(args.cursor, line.length);

    const suggestions = complete(await loadCompletableCommands(), line, cursor);
    if (suggestions.length > 0) {
      process.stdout.write(`${suggestions.join("\n")}\n`);
    }
  },
});

export default completeCmd;

/** Back-compat entry: raw argv → parsed via citty. */
export const runComplete = (args: string[]): Promise<void> => runDef(completeCmd, args);

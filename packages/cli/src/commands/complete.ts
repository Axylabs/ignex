/**
 * `ignex _complete` — the hidden shell-completion backend.
 *
 * Generated completion scripts (see `completions/`) call this with the live
 * command line and cursor offset:
 *
 *   ignex _complete --line "ignex create --runtime b" --cursor 24
 *
 * It prints newline-separated suggestions to stdout (nothing when there are
 * none, so the shell falls back to file completion). Kept out of `ignex help`
 * via the `hidden` flag on the registry entry — `_complete` is an internal
 * protocol, not a user-facing command.
 *
 * The line may be given inline (`--line "..."`) or via a response file
 * (`--line @<path>`) — cmd/clink passes the raw line through a temp file so
 * shell quoting can never corrupt it.
 */
import { readFile } from "node:fs/promises";
import { parseCliArgs } from "../utils/args.js";
import { complete } from "../utils/completion.js";
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

export async function runComplete(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    line: { type: "string" },
    cursor: { type: "string" },
  });

  const line = await resolveLine((values.line as string | undefined) ?? positionals.join(" "));
  const cursor = parseCursor(values.cursor as string | undefined, line.length);

  const suggestions = complete(commands, line, cursor);
  if (suggestions.length > 0) {
    process.stdout.write(`${suggestions.join("\n")}\n`);
  }
}

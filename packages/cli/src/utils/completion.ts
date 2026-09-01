/**
 * @fileoverview Shell-completion engine — the pure logic behind `ignex _complete`.
 *
 * The hidden `_complete` command (see `commands/complete.ts`) receives the live
 * command line plus the cursor offset from a shell's generated completion script
 * and forwards both here. `tokenizeLine` splits the line up to the cursor into
 * completed tokens plus the in-progress token, then `complete` derives candidate
 * commands / flags / flag values from the command table. Paths and free-form
 * positionals intentionally yield nothing so each shell's native file completion
 * takes over (`-o default` in bash, `_files` in zsh, fish/PS defaults).
 *
 * Flags are derived from each command's **typed citty args definition** (the
 * single source of truth shared with parsing and usage rendering) — no more
 * regex-scraping help text, so completions can never drift from reality.
 */

import type { ArgsDef } from "citty";
import { GLOBAL_STAGES } from "../commands/hook.js";
import { FEATURE_NAMES } from "../types.js";

/** Shells that `ignex completions <shell>` can generate a script for. */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell", "cmd"] as const;

/** HTTP verbs accepted by `ignex route --method`. */
export const HTTP_METHODS = ["get", "post", "put", "patch", "del", "all"] as const;

/** Result of tokenizing a command line up to the cursor. */
export interface TokenizedLine {
  /** Completed tokens before the cursor (the program name is first). */
  before: readonly string[];
  /** The in-progress token under the cursor (`""` at a token boundary). */
  current: string;
}

/** A completable flag with any static value candidates it accepts. */
export interface FlagCompletion {
  /** Long flag spelling, e.g. `--runtime`. */
  flag: string;
  /** Static values the flag accepts, when they are enumerable. */
  values?: readonly string[];
}

/** Minimal command shape the engine completes against. */
export interface CompletableCommand {
  name: string;
  aliases?: readonly string[];
  hidden?: boolean;
  flags: readonly FlagCompletion[];
}

const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/**
 * Tokenize `line` up to `cursor`, mirroring shell word-splitting well enough for
 * completion: whitespace splits tokens; single/double quotes and backslash
 * escapes keep the following characters attached to the current token.
 *
 * When the cursor sits on whitespace (or points past the end of the provided
 * text, as PowerShell trims the trailing space) the in-progress token is `""`,
 * i.e. the user is starting a fresh token.
 *
 * @param line - The full command line (including the program name).
 * @param cursor - Character offset of the cursor into `line`.
 * @returns The completed tokens and the in-progress token.
 */
export function tokenizeLine(line: string, cursor: number): TokenizedLine {
  const before: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let inToken = false;

  const bounded = Math.max(0, Math.min(cursor, line.length));
  const end = bounded > line.length ? line.length : bounded;

  // A fresh-token position: at the very start, just after whitespace, or when
  // the cursor is past the text we were given (truncated trailing space).
  const atBoundary =
    bounded === 0 || bounded > line.length || (bounded > 0 && isSpace(line[bounded - 1] ?? ""));

  for (let i = 0; i < end; i++) {
    const ch = line[i] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      inToken = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      inToken = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (isSpace(ch) && !inSingle && !inDouble) {
      if (inToken) before.push(current);
      current = "";
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }

  if (atBoundary && inToken) before.push(current);
  return { before, current: atBoundary ? "" : current };
}

/** camelCase → kebab-case (local to avoid pulling scule into the hot path). */
const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * Generic argument metavariables used across the CLI (`--root <dir>`,
 * `--port <port>`, …). These name a user-supplied argument, NOT a literal
 * value, so they are not expanded into completion candidates.
 */
const GENERIC_HINTS = new Set([
  "dir",
  "port",
  "list",
  "name",
  "action",
  "target",
  "binary",
  "path",
  "image",
  "user",
  "pass",
  "db",
  "var",
  "domain",
  "shell",
  "file",
  "url",
  "value",
  "tag",
  "prefix",
  "semver",
  "host",
]);

/** Values that live outside the CLI definitions, keyed by arg name. */
const NAMED_VALUES: Record<string, readonly string[]> = {
  features: FEATURE_NAMES,
  method: HTTP_METHODS,
  stage: GLOBAL_STAGES,
};

/** Split an enumerable value hint like `"mongo|sql"` into candidate values. */
const valuesFromHint = (
  flagName: string,
  hint: string | undefined,
): readonly string[] | undefined => {
  if (NAMED_VALUES[flagName]) return NAMED_VALUES[flagName];
  if (!hint) return undefined;
  if (hint.includes("|")) {
    return hint
      .split("|")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (GENERIC_HINTS.has(hint)) return undefined;
  return [hint];
};

/**
 * Derive completable flags from a command's typed citty args definition.
 *
 * Booleans whose default is `true` (or explicitly marked `negatable`) also
 * surface their `--no-*` form; enumerable hints like `valueHint: "mongo|sql"`
 * become static value candidates.
 *
 * @param argsDef - The command's citty args definition.
 * @returns Flags in declaration order, kebab-case spelled.
 */
export function flagsFromArgs(argsDef: ArgsDef): readonly FlagCompletion[] {
  const flags: FlagCompletion[] = [];

  for (const [rawName, def] of Object.entries(argsDef ?? {})) {
    if (!def || def.type === "positional") continue;

    const kebabName = kebab(rawName);
    const flag = `--${kebabName}`;

    if (def.type === "boolean") {
      flags.push({ flag });
      const negatable =
        (def as { default?: boolean }).default === true ||
        (def as { negatable?: boolean }).negatable === true;
      if (negatable) flags.push({ flag: `--no-${kebabName}` });
      continue;
    }

    const hint = (def as { valueHint?: string }).valueHint;
    flags.push({ flag, values: valuesFromHint(rawName, hint) });
  }

  return flags;
}

const findCommandIn = (
  cmds: readonly CompletableCommand[],
  name: string,
): CompletableCommand | undefined => cmds.find((c) => c.name === name || c.aliases?.includes(name));

const commandNames = (cmds: readonly CompletableCommand[]): readonly string[] => [
  ...cmds.filter((c) => !c.hidden).flatMap((c) => [c.name, ...(c.aliases ?? [])]),
  "help",
  "--help",
  "-h",
];

const byPrefix =
  (partial: string) =>
  (candidate: string): boolean =>
    candidate.startsWith(partial);

/**
 * Compute candidate completions for `line` with the cursor at `cursor`.
 *
 * Derives command names (plus aliases), per-command flags (from the typed
 * args definitions), and flag values for value-taking flags. Returns an
 * empty list for paths and free-form positionals so the calling shell can fall
 * back to file completion.
 *
 * @param commands - The completable command table.
 * @param line - The full command line including the program name.
 * @param cursor - Character offset of the cursor into `line`.
 * @returns Matching suggestions (newline-free), filtered to the token prefix.
 */
export function complete(
  commands: readonly CompletableCommand[],
  line: string,
  cursor: number,
): string[] {
  const { before, current } = tokenizeLine(line, cursor);
  const args = before.slice(1); // drop the program name
  const partial = current;
  const prev = args[args.length - 1];

  // No command chosen yet → complete command names / aliases (+ help).
  if (args.length === 0) {
    return commandNames(commands).filter(byPrefix(partial));
  }

  const command = findCommandIn(commands, args[0] ?? "");
  if (!command) {
    // Unknown first token → offer command names (e.g. mid-typo recovery).
    return commandNames(commands).filter(byPrefix(partial));
  }

  // `ignex completions <shell>` → complete the known shell names.
  if (command.name === "completions" && args.length === 1) {
    return COMPLETION_SHELLS.filter(byPrefix(partial));
  }

  // Completing a value for a value-taking flag (e.g. `--runtime b`).
  if (prev?.startsWith("-")) {
    const flag = command.flags.find((f) => f.flag === prev);
    if (flag?.values && flag.values.length > 0) {
      return flag.values.filter(byPrefix(partial));
    }
  }

  // Completing flags: the token starts with `-`, or the user is at a fresh
  // token position right after the command.
  if (partial.startsWith("-") || partial === "") {
    return command.flags.map((f) => f.flag).filter(byPrefix(partial));
  }

  // Positional token → no static suggestions; the shell offers files instead.
  return [];
}

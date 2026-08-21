/**
 * @fileoverview Shell-completion engine — the pure logic behind `ignex _complete`.
 *
 * The hidden `_complete` command (see `commands/complete.ts`) receives the live
 * command line plus the cursor offset from a shell's generated completion script
 * and forwards both here. `tokenizeLine` splits the line up to the cursor into
 * completed tokens plus the in-progress token, then `complete` derives candidate
 * commands / flags / flag values from the command registry. Paths and free-form
 * positionals intentionally yield nothing so each shell's native file completion
 * takes over (`-o default` in bash, `_files` in zsh, fish/PS defaults).
 *
 * Flags are parsed from each command's existing `options` doc string (the single
 * source of truth shared with `ignex help`), with a small keyword table for
 * values that live elsewhere (`--features` → `FEATURE_NAMES`, `--method` → HTTP
 * verbs, `--stage` → `GLOBAL_STAGES`).
 */

import { GLOBAL_STAGES } from "../commands/hook.js";
import type { Command } from "../commands/registry.js";
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

/** A flag parsed from a command's `options` doc string, plus any value hints. */
export interface FlagCompletion {
  /** Long flag spelling, e.g. `--runtime`. */
  flag: string;
  /** Static values the flag accepts, when the docs enumerate them. */
  values?: readonly string[];
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

/** Extract every `--flag` (and optional `<a|b|c>` value list) from an options doc. */
const FLAG_PATTERN = /^\s*(--[a-zA-Z][a-zA-Z0-9-]*)(?:\s+<([^>]+)>)?/gm;

/** Keyword → static values for placeholders whose values live outside the docs. */
const PLACEHOLDER_VALUES: Record<string, readonly string[]> = {
  method: HTTP_METHODS,
  stage: GLOBAL_STAGES,
};

/**
 * Generic argument metavariables used in option docs (`--root <dir>`,
 * `--port <port>`, …). These name a user-supplied argument, NOT a literal
 * value, so they are not expanded into completion candidates.
 */
const GENERIC_ARGUMENTS = new Set([
  "dir",
  "port",
  "list",
  "method",
  "stage",
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
]);

/**
 * Parse a command's `options` doc string into its flags and value hints.
 *
 * Inline enums (`--runtime <bun|auto>`) and single literal values
 * (`--runtime <bun>`) become `values`; generic metavariables (`--root <dir>`)
 * and boolean flags have no values; `--features` maps to `FEATURE_NAMES` and
 * the `method`/`stage` placeholders map to the HTTP verbs / lifecycle stages.
 *
 * @param options - The `Command.options` doc string (may be `undefined`).
 * @returns The parsed flags, in declaration order.
 */
export function parseFlagDocs(options: string | undefined): readonly FlagCompletion[] {
  if (!options) return [];
  const flags: FlagCompletion[] = [];
  for (const match of options.matchAll(FLAG_PATTERN)) {
    const flag = match[1] as string;
    const placeholder = match[2];
    let values: readonly string[] | undefined;
    if (flag === "--features") {
      values = FEATURE_NAMES;
    } else if (placeholder) {
      if (placeholder.includes("|")) {
        values = placeholder
          .split("|")
          .map((v) => v.trim())
          .filter(Boolean);
      } else {
        // Known keyword placeholders (`method`/`stage`) map to their value
        // lists first; generic metavariables (`dir`, `port`, …) name a
        // user-supplied argument (no candidates); anything else (`bun`) is a
        // single literal value.
        values =
          PLACEHOLDER_VALUES[placeholder] ??
          (GENERIC_ARGUMENTS.has(placeholder) ? undefined : [placeholder]);
      }
    }
    flags.push({ flag, values });
  }
  return flags;
}

const flagCache = new WeakMap<Command, readonly FlagCompletion[]>();

/** Memoized per-command flag list. */
const flagsOf = (command: Command): readonly FlagCompletion[] => {
  let flags = flagCache.get(command);
  if (!flags) {
    flags = parseFlagDocs(command.options);
    flagCache.set(command, flags);
  }
  return flags;
};

const findCommandIn = (cmds: readonly Command[], name: string): Command | undefined =>
  cmds.find((c) => c.name === name || c.aliases?.includes(name));

const commandNames = (cmds: readonly Command[]): readonly string[] => [
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
 * Derives command names (plus aliases), per-command flags (parsed from the
 * command's `options` docs), and flag values for value-taking flags. Returns an
 * empty list for paths and free-form positionals so the calling shell can fall
 * back to file completion.
 *
 * @param commands - The command registry to complete against.
 * @param line - The full command line including the program name.
 * @param cursor - Character offset of the cursor into `line`.
 * @returns Matching suggestions (newline-free), filtered to the token prefix.
 */
export function complete(commands: readonly Command[], line: string, cursor: number): string[] {
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
    const flag = flagsOf(command).find((f) => f.flag === prev);
    if (flag?.values && flag.values.length > 0) {
      return flag.values.filter(byPrefix(partial));
    }
  }

  // Completing flags: the token starts with `-`, or the user is at a fresh
  // token position right after the command.
  if (partial.startsWith("-") || partial === "") {
    return flagsOf(command)
      .map((f) => f.flag)
      .filter(byPrefix(partial));
  }

  // Positional token → no static suggestions; the shell offers files instead.
  return [];
}

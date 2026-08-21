/**
 * @fileoverview Interactive wizard prompts for the ignex CLI.
 *
 * Modern, zero-dependency prompt primitives — `promptText`, `promptSelect`,
 * `promptMultiSelect`, `promptConfirm` and `promptPassword` — used by the
 * create/route/event/ops wizards:
 *
 *   - Arrow keys (↑/↓, j/k) navigate selects; space toggles multi-selects;
 *     `a` selects all; Enter confirms; Ctrl+C cancels (throws
 *     `PromptCancelError` so wizards can abort cleanly without writing files).
 *   - When stdin is not a TTY (piped scripts, CI, tests) every prompt falls
 *     back to its `initial`/default value instead of hanging, so wizards stay
 *     scriptable.
 *   - The legacy readline helpers (`openPrompt`/`ask`/`askConfirm`) remain for
 *     callers that still want a plain question line.
 *
 * Rendering helpers (`renderOptionLine`, `renderSelectLines`) are exported pure
 * so the UI can be unit-tested without a TTY.
 */

import { createInterface } from "node:readline/promises";
import { bold, cyan, dim, green, red } from "./logger.js";

export type Readline = ReturnType<typeof createInterface>;

/** Thrown when the user cancels an interactive prompt with Ctrl+C. */
export class PromptCancelError extends Error {
  constructor() {
    super("Cancelled by user.");
    this.name = "PromptCancelError";
  }
}

/** A selectable choice: `value` is returned, `label` is shown, `hint` trails. */
export interface SelectOption {
  value: string;
  label?: string;
  hint?: string;
}

export interface TextPromptOptions {
  /** The question shown to the user. */
  message: string;
  /** Default value used on empty input / non-TTY fallback. */
  initial?: string;
  /** Returns an error message when the value is invalid (loops until valid). */
  validate?: (value: string) => string | undefined | null;
}

export interface SelectPromptOptions {
  /** The question shown above the option list. */
  message: string;
  /** The choices (rendered in order). */
  options: readonly SelectOption[];
  /** Default selected value — must match an option `value`. */
  initial?: string;
}

export interface MultiSelectPromptOptions {
  /** The question shown above the option list. */
  message: string;
  /** The choices (rendered in order). */
  options: readonly SelectOption[];
  /** Pre-checked values. */
  initial?: readonly string[];
  /** Optional footer hint shown under the list. */
  hint?: string;
}

export interface ConfirmPromptOptions {
  /** The question shown to the user. */
  message: string;
  /** Default answer used on empty input / non-TTY fallback. */
  initial?: boolean;
}

/** True when both streams are TTYs, i.e. interactive prompting is safe. */
export const isInteractiveTTY = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * `? message` question prefix used by every interactive prompt. Kept in one
 * place so the wizard visual language stays consistent.
 */
const questionPrefix = (): string => cyan("?");

/** Open a readline interface over stdin/stdout (callers must close it). */
export const openPrompt = (): Readline =>
  createInterface({ input: process.stdin, output: process.stdout });

/** Ask an open question; an empty answer falls back to `fallback`. */
export const ask = async (rl: Readline, question: string, fallback = ""): Promise<string> => {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer.length > 0 ? answer : fallback;
};

/** Ask a yes/no confirmation; an empty answer falls back to `fallback`. */
export const askConfirm = async (
  rl: Readline,
  question: string,
  fallback: boolean,
): Promise<boolean> => {
  const suffix = fallback ? "(Y/n)" : "(y/N)";
  const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
};

/** Free-text input with a default, optional validation, and TTY fallback. */
export async function promptText(options: TextPromptOptions): Promise<string> {
  if (!isInteractiveTTY()) return options.initial ?? "";
  const rl = openPrompt();
  try {
    for (;;) {
      const suffix = options.initial ? dim(` (${options.initial})`) : "";
      const answer = (
        await rl.question(`${questionPrefix()} ${options.message}${suffix}: `)
      ).trim();
      const value = answer.length > 0 ? answer : (options.initial ?? "");
      const problem = options.validate?.(value);
      if (problem) {
        console.error(`${red("✖")} ${problem}`);
        continue;
      }
      return value;
    }
  } finally {
    rl.close();
  }
}

/** Yes/no confirmation with a default and TTY fallback. */
export async function promptConfirm(options: ConfirmPromptOptions): Promise<boolean> {
  if (!isInteractiveTTY()) return options.initial ?? false;
  const rl = openPrompt();
  try {
    for (;;) {
      const suffix = options.initial ? "Y/n" : "y/N";
      const answer = (
        await rl.question(`${questionPrefix()} ${options.message} ${dim(`(${suffix})`)} `)
      )
        .trim()
        .toLowerCase();
      if (!answer) return options.initial ?? false;
      if (answer.startsWith("y")) return true;
      if (answer.startsWith("n")) return false;
      console.error(`${red("✖")} Please answer y or n.`);
    }
  } finally {
    rl.close();
  }
}

/** Mutable state for the masked password prompt. */
interface PasswordState {
  input: string;
  rows: number;
}

/**
 * Handle one keystroke of the password prompt (module-level so the complexity
 * stays flat). Returns `true` when the prompt is finished.
 */
function handlePasswordKey(
  ch: string,
  state: PasswordState,
  options: TextPromptOptions,
  actions: {
    fail(err: Error): void;
    resolve(value: string): void;
    cleanup(): void;
    render(): void;
  },
): boolean {
  if (ch === "\x03") {
    actions.fail(new PromptCancelError());
    return true;
  }
  if (ch === "\r" || ch === "\n") {
    const problem = options.validate?.(state.input);
    if (problem) {
      process.stdout.write(`${red("✖")} ${problem}\n`);
      state.input = "";
      state.rows = 0;
      actions.render();
      return false;
    }
    actions.cleanup();
    process.stdout.write("\n");
    actions.resolve(state.input);
    return true;
  }
  if (ch === "\x7f" || ch === "\b") {
    state.input = state.input.slice(0, -1);
  } else if (ch >= " " && ch !== "\x1b") {
    state.input += ch;
  }
  actions.render();
  return false;
}

/**
 * Hidden (masked) input for secrets. Echoes `*` per keystroke; Backspace
 * edits; Enter submits; Ctrl+C cancels. Falls back to `initial` off-TTY.
 */
export async function promptPassword(options: TextPromptOptions): Promise<string> {
  if (!isInteractiveTTY()) return options.initial ?? "";
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw;
  const state: PasswordState = { input: "", rows: 0 };

  const render = (): void => {
    const mask = state.input.length > 0 ? "*".repeat(state.input.length) : dim("(type to enter)");
    if (state.rows > 0) stdout.write(`\x1b[${state.rows}A`);
    const line = `${questionPrefix()} ${options.message} ${mask}`;
    stdout.write(`\x1b[2K${line}`);
    state.rows = 1;
  };

  return await new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // stream may already be destroyed — nothing to restore
      }
      stdin.off("data", onData);
      stdin.pause();
    };
    const fail = (err: Error): void => {
      cleanup();
      stdout.write("\n");
      reject(err);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of String(chunk)) {
        if (handlePasswordKey(ch, state, options, { fail, resolve, cleanup, render })) return;
      }
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      render();
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Render a single option line; `active` highlights it, `checked` toggles boxes. */
export function renderOptionLine(
  option: SelectOption,
  active: boolean,
  checked: boolean | null,
): string {
  const label = option.label ?? option.value;
  const hint = option.hint ? dim(` — ${option.hint}`) : "";
  if (checked !== null) {
    const box = checked ? green("●") : dim("○");
    const prefix = active ? cyan("›") : " ";
    return `${prefix} ${box} ${label}${hint}`;
  }
  if (active) return `${cyan("›")} ${cyan(bold(label))}${hint}`;
  return `  ${label}${hint}`;
}

/**
 * Render the full option list for a select/multi-select. Exported pure so the
 * wizard UI is unit-testable without a TTY.
 */
export function renderSelectLines(
  options: readonly SelectOption[],
  index: number,
  checked: readonly number[] | null,
): string[] {
  return options.map((option, i) =>
    renderOptionLine(option, i === index, checked === null ? null : checked.includes(i)),
  );
}

/** Parse a raw-mode key chunk into a select action. Exported for tests. */
export type SelectKeyAction = "up" | "down" | "toggle" | "all" | "confirm" | "cancel" | "none";

export function parseSelectKey(data: string): SelectKeyAction {
  if (data === "\x03") return "cancel";
  if (data === "\r" || data === "\n") return "confirm";
  if (data === " ") return "toggle";
  if (data === "a" || data === "A") return "all";
  if (data === "\x1b[A" || data === "k" || data === "K") return "up";
  if (data === "\x1b[B" || data === "j" || data === "J") return "down";
  return "none";
}

/** Mutable selection state shared by the raw select engine. */
interface SelectState {
  index: number;
  selected: Set<number>;
}

/** Outcome of one keypress: re-render, commit, cancel, or do nothing. */
type SelectOutcome = "render" | "commit" | "cancel" | "none";

/** Apply a parsed key action to the selection state. */
function applySelectAction(
  action: SelectKeyAction,
  state: SelectState,
  options: readonly SelectOption[],
  multi: boolean,
): SelectOutcome {
  switch (action) {
    case "up":
      state.index = (state.index - 1 + options.length) % options.length;
      return "render";
    case "down":
      state.index = (state.index + 1) % options.length;
      return "render";
    case "toggle":
      if (!multi) {
        state.selected.clear();
        state.selected.add(state.index);
        return "commit";
      }
      if (state.selected.has(state.index)) state.selected.delete(state.index);
      else state.selected.add(state.index);
      return "render";
    case "all":
      if (multi) {
        if (state.selected.size === options.length) state.selected.clear();
        else for (let i = 0; i < options.length; i++) state.selected.add(i);
      }
      return "render";
    case "confirm":
      if (!multi) {
        state.selected.clear();
        state.selected.add(state.index);
      }
      return "commit";
    case "cancel":
      return "cancel";
    default:
      return "none";
  }
}

/** Mutable key-buffer for the raw select engine. */
interface SelectBufferState {
  buffer: string;
}

/**
 * Consume buffered key bytes, dispatching each parsed action to `finish`
 * (module-level so the input loop stays flat). Escape sequences are matched
 * longest-first; unknown escapes are swallowed one byte at a time so the
 * buffer can't grow unboundedly. Stops as soon as the prompt resolves or
 * cancels, so leftover keys are NOT eaten by this prompt — they stay buffered
 * for the next one (e.g. chained wizard questions).
 */
function consumeSelectBuffer(
  bufferState: SelectBufferState,
  state: SelectState,
  options: readonly SelectOption[],
  multi: boolean,
  finish: (outcome: SelectOutcome) => boolean,
): void {
  for (;;) {
    if (bufferState.buffer.startsWith("\x1b[A") || bufferState.buffer.startsWith("\x1b[B")) {
      const action = bufferState.buffer.startsWith("\x1b[A") ? "up" : "down";
      bufferState.buffer = bufferState.buffer.slice(3);
      if (finish(applySelectAction(action, state, options, multi))) return;
    } else if (bufferState.buffer.startsWith("\x1b")) {
      bufferState.buffer = bufferState.buffer.slice(1);
      if (finish(applySelectAction("none", state, options, multi))) return;
    } else if (bufferState.buffer.length > 0) {
      const ch = bufferState.buffer[0] ?? "";
      bufferState.buffer = bufferState.buffer.slice(1);
      if (ch.length > 0 && finish(applySelectAction(parseSelectKey(ch), state, options, multi))) {
        return;
      }
    } else {
      break;
    }
  }
}

/**
 * Shared raw-mode engine behind `promptSelect` / `promptMultiSelect`.
 * Renders the option list, navigates with arrows, resolves with the chosen
 * value(s) or rejects with `PromptCancelError`.
 */
async function rawSelect(
  options: { message: string; options: readonly SelectOption[]; hint?: string },
  multi: boolean,
  initial: readonly string[],
): Promise<string[]> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw;
  const initialIndexes = initial
    .map((value) => options.options.findIndex((o) => o.value === value))
    .filter((i) => i >= 0);
  const state: SelectState = {
    index: initialIndexes[0] ?? 0,
    selected: new Set<number>(multi ? initialIndexes : initialIndexes.slice(0, 1)),
  };
  const bufferState: SelectBufferState = { buffer: "" };
  let rows = 0;

  const render = (): void => {
    const lines = renderSelectLines(
      options.options,
      state.index,
      multi ? [...state.selected] : null,
    );
    const footer = options.hint ? dim(`  ${options.hint}`) : "";
    const all = [...lines, footer].filter((line) => line.length > 0);
    if (rows > 0) stdout.write(`\x1b[${rows}A`);
    stdout.write(all.map((line) => `\x1b[2K${line}`).join("\n"));
    rows = all.length;
  };

  return await new Promise<string[]>((resolve, reject) => {
    const cleanup = (): void => {
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // stream may already be destroyed — nothing to restore
      }
      stdin.off("data", onData);
      stdin.pause();
    };
    const finish = (outcome: SelectOutcome): boolean => {
      if (outcome === "cancel") {
        cleanup();
        stdout.write("\n");
        reject(new PromptCancelError());
        return true;
      }
      if (outcome === "commit") {
        cleanup();
        stdout.write("\n");
        resolve(options.options.filter((_, i) => state.selected.has(i)).map((o) => o.value));
        return true;
      }
      if (outcome === "render") render();
      return false;
    };
    const onData = (chunk: Buffer | string): void => {
      bufferState.buffer += String(chunk);
      consumeSelectBuffer(bufferState, state, options.options, multi, finish);
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      render();
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Single-choice select (arrow keys, Enter to confirm). */
export async function promptSelect(options: SelectPromptOptions): Promise<string> {
  if (!isInteractiveTTY()) return options.initial ?? options.options[0]?.value ?? "";
  if (options.options.length === 0) {
    throw new Error("promptSelect requires at least one option.");
  }
  const [value] = await rawSelect(options, false, options.initial ? [options.initial] : []);
  return value ?? "";
}

/** Multi-choice select (space toggles, `a` selects all, Enter confirms). */
export async function promptMultiSelect(options: MultiSelectPromptOptions): Promise<string[]> {
  if (!isInteractiveTTY()) return [...(options.initial ?? [])];
  if (options.options.length === 0) return [];
  return rawSelect(options, true, options.initial ?? []);
}

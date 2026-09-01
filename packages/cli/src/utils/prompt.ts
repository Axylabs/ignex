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
  message: string;
  initial?: string;
  validate?: (value: string) => string | undefined | null;
}

export interface SelectPromptOptions {
  message: string;
  options: readonly SelectOption[];
  initial?: string;
}

export interface MultiSelectPromptOptions {
  message: string;
  options: readonly SelectOption[];
  initial?: readonly string[];
  hint?: string;
}

export interface ConfirmPromptOptions {
  message: string;
  initial?: boolean;
}

export const isInteractiveTTY = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const questionPrefix = (): string => cyan("?");

export const openPrompt = (): Readline =>
  createInterface({ input: process.stdin, output: process.stdout });

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

interface PasswordState {
  input: string;
  rows: number;
}

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

export async function promptPassword(options: TextPromptOptions): Promise<string> {
  if (!isInteractiveTTY()) return options.initial ?? "";
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw;
  const state: PasswordState = { input: "", rows: 0 };

  const render = (): void => {
    const mask = state.input.length > 0 ? "*".repeat(state.input.length) : dim("(type to enter)");

    // FIX: Use \r to return to the start of the line, then \x1b[2K to clear it entirely.
    // This prevents the "shifting down" bug on every keystroke.
    if (state.rows > 0) {
      stdout.write("\x1b[2K\r");
    }

    const line = `${questionPrefix()} ${options.message} ${mask}`;
    stdout.write(line);
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

export function renderSelectLines(
  options: readonly SelectOption[],
  index: number,
  checked: readonly number[] | null,
): string[] {
  return options.map((option, i) =>
    renderOptionLine(option, i === index, checked === null ? null : checked.includes(i)),
  );
}

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

interface SelectState {
  index: number;
  selected: Set<number>;
}

type SelectOutcome = "render" | "commit" | "cancel" | "none";

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

interface SelectBufferState {
  buffer: string;
}

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
  let _rows = 0;

  const render = (): void => {
    const lines = renderSelectLines(
      options.options,
      state.index,
      multi ? [...state.selected] : null,
    );
    const footer = options.hint ? dim(`  ${options.hint}`) : "";
    const all = [...lines, footer].filter((line) => line.length > 0);

    // Clear previous content by moving to home and clearing lines,
    // then write the new render positioned at the top.
    stdout.write("\x1b[2J\x1b[H");

    // Write the new lines
    stdout.write(all.map((line) => `\x1b[2K${line}`).join("\n"));
    _rows = all.length;
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

export async function promptSelect(options: SelectPromptOptions): Promise<string> {
  if (!isInteractiveTTY()) return options.initial ?? options.options[0]?.value ?? "";
  if (options.options.length === 0) {
    throw new Error("promptSelect requires at least one option.");
  }
  const [value] = await rawSelect(options, false, options.initial ? [options.initial] : []);
  return value ?? "";
}

export async function promptMultiSelect(options: MultiSelectPromptOptions): Promise<string[]> {
  if (!isInteractiveTTY()) return [...(options.initial ?? [])];
  if (options.options.length === 0) return [];
  return rawSelect(options, true, options.initial ?? []);
}

/**
 * @fileoverview Interactive wizard prompts for the ignex CLI.
 *
 * Thin wrappers over `@clack/prompts` (the de-facto standard CLI prompt
 * library) exposing the small surface the create/route/event/ops wizards
 * use. All raw-mode, keypress and terminal edge-case handling lives in
 * clack; this file only maps options and normalizes cancel + non-TTY
 * fallback behavior:
 *
 *   - Arrow keys (↑/↓, j/k) navigate selects; space toggles multi-selects;
 *     `a` selects all; Enter confirms; Ctrl+C cancels — clack resolves the
 *     cancel symbol, which we translate into a thrown `PromptCancelError`
 *     so wizards can abort cleanly without writing files.
 *   - When stdin is not a TTY (piped scripts, CI, tests) every prompt falls
 *     back to its `initial`/default value instead of hanging, so wizards stay
 *     scriptable.
 */

import {
  confirm as clackConfirm,
  multiselect as clackMultiselect,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
  isCancel,
} from "@clack/prompts";

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
}

export interface ConfirmPromptOptions {
  message: string;
  initial?: boolean;
}

export const isInteractiveTTY = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Map our `label`-optional options to clack's (which require `label`). */
const toClackOptions = (options: readonly SelectOption[]) =>
  options.map((option) => ({
    value: option.value,
    label: option.label ?? option.value,
    hint: option.hint,
  }));

/** clack resolves Ctrl+C to a cancel symbol — surface it as our own error. */
const rejectOnCancel = <T>(result: T | symbol): T => {
  if (isCancel(result)) throw new PromptCancelError();
  return result;
};

/** Adapt our `validate` (nullable result) to clack's `Validate` signature. */
const toClackValidate =
  (validate?: TextPromptOptions["validate"]) =>
  (input: string | undefined): string | undefined => {
    if (!validate) return undefined;
    return validate(input ?? "") ?? undefined;
  };

export async function promptText(options: TextPromptOptions): Promise<string> {
  if (!isInteractiveTTY()) return options.initial ?? "";
  const value = await clackText({
    message: options.message,
    defaultValue: options.initial,
    validate: toClackValidate(options.validate),
  });
  return rejectOnCancel(value);
}

export async function promptConfirm(options: ConfirmPromptOptions): Promise<boolean> {
  if (!isInteractiveTTY()) return options.initial ?? false;
  const value = await clackConfirm({
    message: options.message,
    // Keep the original default (No) when the caller doesn't specify one.
    initialValue: options.initial ?? false,
  });
  return rejectOnCancel(value);
}

export async function promptPassword(options: TextPromptOptions): Promise<string> {
  if (!isInteractiveTTY()) return options.initial ?? "";
  const value = await clackPassword({
    message: options.message,
    validate: toClackValidate(options.validate),
  });
  return rejectOnCancel(value);
}

export async function promptSelect(options: SelectPromptOptions): Promise<string> {
  if (!isInteractiveTTY()) return options.initial ?? options.options[0]?.value ?? "";
  if (options.options.length === 0) {
    throw new Error("promptSelect requires at least one option.");
  }
  const value = await clackSelect({
    message: options.message,
    options: toClackOptions(options.options),
    initialValue: options.initial,
  });
  return rejectOnCancel(value);
}

export async function promptMultiSelect(options: MultiSelectPromptOptions): Promise<string[]> {
  if (!isInteractiveTTY()) return [...(options.initial ?? [])];
  if (options.options.length === 0) return [];
  const values = await clackMultiselect({
    message: options.message,
    options: toClackOptions(options.options),
    initialValues: options.initial ? [...options.initial] : undefined,
    required: false,
  });
  return rejectOnCancel(values);
}

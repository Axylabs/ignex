/**
 * @fileoverview Interactive prompt helpers (TTY readline), shared by the
 * `create` and `route` commands so prompting is defined in exactly one place.
 */

import { createInterface } from "node:readline/promises";

export type Readline = ReturnType<typeof createInterface>;

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

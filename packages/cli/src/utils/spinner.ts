/**
 * @fileoverview A tiny zero-dependency terminal spinner for long-running CLI
 * operations (builds, installs, docker compose). Draws an animated frame line
 * on stderr, only when stderr is a TTY, and never leaves residue behind.
 */

import { cyan } from "./logger.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A running spinner. Call `stop()` to clear it; `succeed`/`fail` finalize it. */
export interface Spinner {
  /** Stop the spinner, leaving the current line clear (then `final` if given). */
  stop(final?: string): void;
  /** Stop the spinner and print a success line. */
  succeed(message: string): void;
  /** Stop the spinner and print an error line. */
  fail(message: string): void;
}

/** Start a spinner with the given message (no-op when not a TTY). */
export function startSpinner(message: string): Spinner {
  const stream = process.stderr;
  const enabled = Boolean(stream.isTTY);
  if (!enabled) {
    stream.write(`… ${message}\n`);
    return {
      stop: () => undefined,
      succeed: (m) => stream.write(`${cyan("✔")} ${m}\n`),
      fail: (m) => stream.write(`${cyan("✖")} ${m}\n`),
    };
  }

  let frame = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    frame = (frame + 1) % FRAMES.length;
    stream.write(`\r\x1b[2K${cyan(FRAMES[frame] ?? "")} ${message}`);
  }, 80);

  const clear = (): void => {
    stream.write("\r\x1b[2K");
  };

  return {
    stop(final) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clear();
      if (final) stream.write(`${final}\n`);
    },
    succeed(m) {
      this.stop(`${cyan("✔")} ${m}`);
    },
    fail(m) {
      this.stop(`${cyan("✖")} ${m}`);
    },
  };
}

/**
 * @fileoverview Terminal-width helpers for CLI tables — Bun-first.
 *
 * Padding and truncation must count *display* columns, not UTF-16 code units:
 * ANSI color sequences occupy zero columns and wide glyphs (CJK, emoji)
 * occupy two. Bun ships `Bun.stringWidth`, `Bun.sliceAnsi` and `Bun.wrapAnsi`
 * for exactly this; the helpers below prefer them and fall back to naive
 * `.length` behavior when the Bun global is unavailable (test sandboxes).
 */

type BunTerminal = {
  stringWidth?: (input: string) => number;
  sliceAnsi?: (input: string, from: number, to?: number) => string;
  wrapAnsi?: (input: string, columns: number) => string[];
};

const bun = (globalThis as { Bun?: BunTerminal }).Bun;

/** Display columns of `input` (0 for empty/whitespace-only strings). */
export function stringWidth(input: string): number {
  const width = bun?.stringWidth;
  if (width !== undefined) {
    const w = width(input);
    return Number.isFinite(w) && w > 0 ? w : 0;
  }
  return input.length;
}

/**
 * Pad `input` to `width` display columns with trailing spaces (or truncate
 * with `…` when it already exceeds the width). ANSI-safe under Bun.
 */
export function padAnsi(input: string, width: number): string {
  const w = stringWidth(input);
  if (w >= width) return truncateAnsi(input, width);
  return input + " ".repeat(width - w);
}

/** Truncate to `width` display columns, appending `…` when cut. ANSI-safe. */
export function truncateAnsi(input: string, width: number): string {
  if (stringWidth(input) <= width) return input;
  const slice = bun?.sliceAnsi;
  if (slice !== undefined) {
    const cut = slice(input, 0, Math.max(width - 1, 0));
    return `${cut}…`;
  }
  return `${input.slice(0, Math.max(width - 1, 0))}…`;
}

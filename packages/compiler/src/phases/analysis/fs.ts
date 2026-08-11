/**
 * @fileoverview Analysis: shared file reads (app-config + hook resolution).
 */

import { readFileSync } from "node:fs";

/**
 * Read a file as UTF-8. Returns `undefined` on failure so callers can
 * distinguish an unreadable file from a legitimately empty one (`""`). Read
 * failures are surfaced as `IGN_IO_READ_FAILED` diagnostics by callers.
 */
export const safeReadFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

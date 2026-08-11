/**
 * @fileoverview Analysis: shared file reads (app-config + hook resolution).
 */

import { readFileSync } from "node:fs";

/** Read a file as UTF-8, returning `""` on any failure (best-effort reads). */
export const safeReadFile = (path: string): string => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
};

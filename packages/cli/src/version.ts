/**
 * @fileoverview CLI version — read from package.json at runtime (the package
 * ships source-only, so the relative lookup resolves both from the repo and
 * from an installed copy).
 */

import { readFileSync } from "node:fs";

/** The CLI version string, e.g. "0.1.7". Falls back to "0.0.0" on failure. */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

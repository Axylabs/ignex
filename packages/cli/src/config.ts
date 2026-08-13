import type { CompilerOptions } from "@ignex/compiler";

/**
 * Helper for userland ignex.config.ts files.
 *
 * Example:
 *
 * ```ts
 * import { defineConfig } from "@ignex/cli/config";
 *
 * export default defineConfig({
 *   routesDir: "src/routes",
 *   outDir: ".ignex",
 * });
 * ```
 */
export function defineConfig(config: Partial<CompilerOptions>): Partial<CompilerOptions> {
  return config;
}

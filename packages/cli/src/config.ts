import type { CompilerOptions } from "@ignus/compiler";

/**
 * Helper for userland ignus.config.ts files.
 *
 * Example:
 *
 * ```ts
 * import { defineConfig } from "@ignus/cli/config";
 *
 * export default defineConfig({
 *   routesDir: "src/routes",
 *   outDir: ".ignus",
 * });
 * ```
 */
export function defineConfig(config: Partial<CompilerOptions>): Partial<CompilerOptions> {
  return config;
}

import type { CompilerOptions } from "@flux/compiler";

/**
 * Helper for userland flux.config.ts files.
 *
 * Example:
 *
 * ```ts
 * import { defineConfig } from "@flux/cli/config";
 *
 * export default defineConfig({
 *   routesDir: "src/routes",
 *   outDir: ".flux",
 * });
 * ```
 */
export function defineConfig(config: Partial<CompilerOptions>): Partial<CompilerOptions> {
  return config;
}
import type { CompilerOptions, SdkOptions } from "@ignex/compiler";

/** Project-local SDK settings; artifact and local install paths come from the CLI. */
export type SdkProjectOptions = Omit<SdkOptions, "outDir" | "localInstallPath">;

/** Ignex project configuration, including compiler and SDK generation settings. */
export interface IgnexProjectConfig extends Partial<CompilerOptions> {
  /** Defaults for `ignex sdk`; CLI flags take precedence. */
  sdk?: SdkProjectOptions;
}

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
export function defineConfig(config: IgnexProjectConfig): IgnexProjectConfig {
  return config;
}

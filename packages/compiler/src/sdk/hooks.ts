/**
 * @fileoverview Pure SDK generation hooks and generated-file validation.
 */

import type {
  SdkFile,
  SdkGenerateContext,
  SdkGenerationHooks,
  SdkPackageHookContext,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate portable, collision-free package-relative output paths. */
export const validateSdkFiles = (files: readonly SdkFile[], platform: string): void => {
  if (!Array.isArray(files)) {
    throw new Error(`SDK platform "${platform}" must return an array of files`);
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (file === null || typeof file !== "object") {
      throw new Error(`SDK platform "${platform}" emitted an invalid file entry`);
    }
    const path = file.path;
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === ".." || part.length === 0)
    ) {
      throw new Error(
        `SDK platform "${platform}" emitted an unsafe file path: ${JSON.stringify(path)}`,
      );
    }
    if (seen.has(path)) {
      throw new Error(`SDK platform "${platform}" emitted duplicate file path "${path}"`);
    }
    if (typeof file.content !== "string") {
      throw new Error(`SDK platform "${platform}" emitted non-string content for "${path}"`);
    }
    seen.add(path);
  }
};

/** Apply package and file transforms without allowing filesystem side effects. */
export const applySdkHooks = async (
  files: readonly SdkFile[],
  ctx: SdkGenerateContext,
  platform: string,
  hooks: SdkGenerationHooks | undefined,
): Promise<readonly SdkFile[]> => {
  validateSdkFiles(files, platform);
  if (hooks === undefined) return files;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("SDK hooks must be a plain options object");
  }

  const hookCtx: SdkPackageHookContext = { ...ctx, platform };
  let transformed = files;
  if (hooks.transformPackageJson !== undefined) {
    const packageFile = transformed.find((file) => file.path === "package.json");
    if (packageFile === undefined) {
      throw new Error(`SDK package hook requires "${platform}" to emit package.json`);
    }
    const input = JSON.parse(packageFile.content) as unknown;
    if (!isRecord(input)) {
      throw new Error(`SDK platform "${platform}" emitted a non-object package.json`);
    }
    const output = await hooks.transformPackageJson(input, hookCtx);
    if (!isRecord(output)) {
      throw new Error(`SDK transformPackageJson for "${platform}" must return a plain object`);
    }
    transformed = transformed.map((file) =>
      file.path === "package.json"
        ? { path: file.path, content: `${JSON.stringify(output, null, 2)}\n` }
        : file,
    );
  }

  if (hooks.transformFiles !== undefined) {
    transformed = await hooks.transformFiles(transformed, hookCtx);
  }
  validateSdkFiles(transformed, platform);
  return transformed;
};

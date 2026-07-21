/**
 * @fileoverview Phase 5: LINKER
 * Uses esbuild for safe minification and source maps.
 *
 * Design:
 * - Pure transform-option factories
 * - No explicit undefined properties
 * - Minimal IO boundary
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { transformSync, type TransformOptions } from "esbuild";
import type { CompilerOptions } from "../types";
import type { Logger } from "../logger";

const BASE_TRANSFORM: TransformOptions = {
  loader: "js",
  target: "esnext",
  format: "esm",
};

/**
 * Create esbuild options for standalone minification.
 */
const createMinifyOptions = (): TransformOptions => ({
  ...BASE_TRANSFORM,
  minify: true,
});

/**
 * Create esbuild options for standalone source map emission.
 */
const createSourceMapOptions = (fileName: string): TransformOptions => ({
  ...BASE_TRANSFORM,
  sourcefile: fileName,
  sourcemap: "external",
  minify: false,
});

/**
 * Create linker transform options only when needed.
 *
 * Returning undefined signals:
 * "no transform required, write original code".
 */
const createLinkOptions = (
  opts: CompilerOptions,
): TransformOptions | undefined => {
  if (!opts.minify && !opts.sourceMap) return undefined;

  const options: TransformOptions = {
    ...BASE_TRANSFORM,
    minify: opts.minify,
    sourcefile: opts.outFile,
  };

  if (opts.sourceMap) {
    return {
      ...options,
      sourcemap: "external",
    };
  }

  return options;
};

/**
 * Write final output and optional source map.
 */
const writeLinkedOutput = (
  outPath: string,
  code: string,
  map: string | undefined,
  opts: CompilerOptions,
): string => {
  if (opts.sourceMap && map) {
    const codeWithMap = `${code}
//# sourceMappingURL=${opts.outFile}.map`;

    writeFileSync(outPath, codeWithMap);
    writeFileSync(`${outPath}.map`, map);

    return codeWithMap;
  }

  writeFileSync(outPath, code);
  return code;
};

export const minifyCode = (code: string): string =>
  transformSync(code, createMinifyOptions()).code;

export const emitSourceMap = (fileName: string, code: string): string =>
  transformSync(code, createSourceMapOptions(fileName)).map;

export const runLinker = (
  code: string,
  opts: CompilerOptions,
  logger: Logger,
): string =>
  logger.time("linker", () => {
    mkdirSync(opts.outDir, { recursive: true });

    const outPath = join(opts.outDir, opts.outFile);
    const transformOptions = createLinkOptions(opts);

    if (!transformOptions) {
      writeFileSync(outPath, code);

      logger.info(
        `Linked → ${outPath} (${(Buffer.byteLength(code) / 1024).toFixed(1)} KB)`,
      );

      return outPath;
    }

    const result = transformSync(code, transformOptions);
    const finalCode = writeLinkedOutput(outPath, result.code, result.map, opts);

    logger.info(
      `Linked → ${outPath} (${(Buffer.byteLength(finalCode) / 1024).toFixed(1)} KB)`,
    );

    return outPath;
  });
/**
 * @fileoverview Phase 5: LINKER
 * Uses esbuild for safe minification and source maps.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { transformSync } from "esbuild";
import type { CompilerOptions } from "../types";
import type { Logger } from "../logger";

export const minifyCode = (code: string): string => {
  return transformSync(code, {
    minify: true,
    loader: "js",
    target: "esnext",
    format: "esm",
  }).code;
};

export const emitSourceMap = (fileName: string, code: string): string => {
  return transformSync(code, {
    loader: "js",
    sourcefile: fileName,
    sourcemap: "external",
    minify: false,
  }).map;
};

export const runLinker = (
  code: string,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("linker", () => {
    mkdirSync(opts.outDir, { recursive: true });

    let finalCode = code;
    let map: string | undefined;

    if (opts.minify || opts.sourceMap) {
      const result = transformSync(code, {
        minify: opts.minify,
        loader: "js",
        target: "esnext",
        format: "esm",
        sourcefile: opts.outFile,
        sourcemap: opts.sourceMap ? "external" : undefined,
      });

      finalCode = result.code;
      map = result.map;
    }

    const outPath = join(opts.outDir, opts.outFile);

    if (opts.sourceMap && map) {
      finalCode += `\n//# sourceMappingURL=${opts.outFile}.map`;
      writeFileSync(outPath, finalCode);
      writeFileSync(outPath + ".map", map);
    } else {
      writeFileSync(outPath, finalCode);
    }

    logger.info(
      `Linked → ${outPath} (${(Buffer.byteLength(finalCode) / 1024).toFixed(1)} KB)`
    );

    return outPath;
  });
/**
 * Phase 5: LINKER — Bun 1.4 edition.
 *
 * Important:
 * - The temporary Bun.build entry MUST live in opts.outDir.
 * - Generated import paths are relative to opts.outDir.
 */

import {
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  existsSync,
} from "fs";
import { join, basename } from "path";

import type { CompilerOptions } from "../types";
import type { Logger } from "../logger";

const bun: any = (globalThis as any).Bun;

const writeRaw = (
  outPath: string,
  code: string,
  logger: Logger,
  warning?: string
): string => {
  if (warning) {
    logger.warn(warning);
  }

  writeFileSync(outPath, code);

  logger.info(
    `Linked → ${outPath} (${(Buffer.byteLength(code) / 1024).toFixed(1)} KB)`
  );

  return outPath;
};

export const runLinkerAsync = async (
  code: string,
  opts: CompilerOptions,
  logger: Logger
): Promise<string> => {
  const start = performance.now();

  mkdirSync(opts.outDir, { recursive: true });

  const outPath = join(opts.outDir, opts.outFile);

  if (!bun?.build) {
    return writeRaw(
      outPath,
      code,
      logger,
      "Bun.build unavailable. Wrote unminified output."
    );
  }

  if (!opts.minify && !opts.sourceMap) {
    return writeRaw(outPath, code, logger);
  }

  /**
   * IMPORTANT:
   *
   * This entry file must be inside opts.outDir.
   *
   * Correct:
   *   dist/.__server.js.entry.js
   *
   * Wrong:
   *   dist/.flux-link/__server.js
   *
   * Because generated imports are relative to dist/.
   */
  const entryPath = join(opts.outDir, `.${opts.outFile}.entry.js`);

  await bun.write(entryPath, code);

  const buildOptions: any = {
    entrypoints: [entryPath],
    outdir: opts.outDir,
    target: "bun",
    format: "esm",
    minify: opts.minify,
    sourcemap: opts.sourceMap ? "external" : "none",
  };

  let result: any;

  try {
    result = await bun.build(buildOptions);
  } catch (err) {
    rmSync(entryPath, { force: true });

    throw new Error(
      `Bun.build threw an exception:\n${(err as Error).message}`
    );
  }

  if (!result.success) {
    const message = (result.logs ?? [])
      .map((log: any) => log?.message ?? String(log))
      .join("\n");

    rmSync(entryPath, { force: true });

    throw new Error(`Bun.build failed:\n${message}`);
  }

  const builtPath: string | undefined = result.outputs?.[0]?.path;

  if (builtPath && existsSync(builtPath)) {
    if (builtPath !== outPath) {
      renameSync(builtPath, outPath);
    }
  } else if (existsSync(entryPath)) {
    if (entryPath !== outPath) {
      renameSync(entryPath, outPath);
    }
  }

  if (opts.sourceMap) {
    const mapSource = builtPath
      ? `${builtPath}.map`
      : `${entryPath}.map`;

    const mapOut = `${outPath}.map`;

    if (existsSync(mapSource) && mapSource !== mapOut) {
      renameSync(mapSource, mapOut);
    }

    if (existsSync(outPath)) {
      const text = await bun.file(outPath).text();

      const fixed = text.replace(
        /\/\/# sourceMappingURL=.*$/m,
        `//# sourceMappingURL=${basename(mapOut)}`
      );

      await bun.write(outPath, fixed);
    }
  }

  if (existsSync(entryPath) && entryPath !== outPath) {
    rmSync(entryPath, { force: true });
  }

  const finalCode = existsSync(outPath)
    ? await bun.file(outPath).text()
    : code;

  const elapsed = (performance.now() - start).toFixed(2);

  logger.info(
    `Linked → ${outPath} (${(Buffer.byteLength(finalCode) / 1024).toFixed(1)} KB)`
  );

  logger.info(`linker completed in ${elapsed}ms`);

  return outPath;
};

/**
 * Sync fallback.
 *
 * Bun.build is async, so synchronous compile() cannot use it.
 * Prefer buildAsync() in production.
 */
export const runLinker = (
  code: string,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("linker", () => {
    mkdirSync(opts.outDir, { recursive: true });

    const outPath = join(opts.outDir, opts.outFile);

    return writeRaw(
      outPath,
      code,
      logger,
      "Sync linker wrote unminified output. Use buildAsync() for Bun.build minification."
    );
  });

/**
 * Compatibility stubs.
 *
 * The old esbuild linker exported these.
 * They are no longer used by the Bun.build linker.
 */
export const minifyCode = (code: string): string => code;

export const emitSourceMap = (
  _fileName: string,
  _code: string
): string => "";
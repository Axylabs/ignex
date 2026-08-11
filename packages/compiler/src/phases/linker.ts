/**
 * Phase 5: LINKER — Bun 1.4 edition.
 *
 * Important:
 * - The temporary Bun.build entry MUST live in opts.outDir.
 * - Generated import paths are relative to opts.outDir.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DiagnosticCodes, errorMessage } from "../diagnostics";
import type { CompilerContext, CompilerOptions } from "../types";

export const formatBuildLogs = (input: unknown): string => {
  const logs: any[] = Array.isArray(input)
    ? input
    : input && typeof input === "object" && "logs" in input
      ? ((input as any).logs ?? [])
      : [];

  if (!logs.length) return "";

  return (
    "\n" +
    logs
      .map((log) => {
        if (typeof log === "string") return log;

        const pos = log?.position
          ? ` (${log.position.file}:${log.position.line}:${log.position.column})`
          : "";

        return `${log?.message ?? String(log)}${pos}`;
      })
      .join("\n")
  );
};

const bun: any = (globalThis as any).Bun;

const writeRaw = (
  outPath: string,
  code: string,
  ctx: CompilerContext,
  warning?: string,
): string => {
  if (warning) {
    ctx.logger.warn(warning);
  }

  writeFileSync(outPath, code);

  ctx.logger.info(`Linked → ${outPath} (${(Buffer.byteLength(code) / 1024).toFixed(1)} KB)`);

  return outPath;
};

export const runLinkerAsync = async (
  code: string,
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<string> => {
  const start = performance.now();

  mkdirSync(opts.outDir, { recursive: true });

  const outPath = join(opts.outDir, opts.outFile);

  if (!bun?.build) {
    return writeRaw(outPath, code, ctx, "Bun.build unavailable. Wrote unminified output.");
  }

  if (!opts.minify && !opts.sourceMap) {
    return writeRaw(outPath, code, ctx);
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
   *   dist/.ignus-link/__server.js
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
  } catch (err: any) {
    rmSync(entryPath, { force: true });

    const details = formatBuildLogs(
      err?.errors ?? err?.logs ?? err?.cause?.errors ?? err?.cause?.logs,
    );

    ctx.diagnostics.error({
      code: DiagnosticCodes.LinkFailed,
      message: `Bun.build threw an exception: ${errorMessage(err)}${details}`,
    });

    // Reported as an error diagnostic; the pipeline's final `hasErrors` check
    // surfaces the structured summary (no mid-pipeline throw).
    return outPath;
  }

  if (!result.success) {
    const message = (result.logs ?? []).map((log: any) => log?.message ?? String(log)).join("\n");

    rmSync(entryPath, { force: true });

    ctx.diagnostics.error({
      code: DiagnosticCodes.LinkFailed,
      message: `Bun.build failed: ${message}`,
    });

    // Reported as an error diagnostic; the pipeline's final `hasErrors` check
    // surfaces the structured summary (no mid-pipeline throw).
    return outPath;
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
    const mapSource = builtPath ? `${builtPath}.map` : `${entryPath}.map`;

    const mapOut = `${outPath}.map`;

    if (existsSync(mapSource) && mapSource !== mapOut) {
      renameSync(mapSource, mapOut);
    }

    if (existsSync(outPath)) {
      const text = await bun.file(outPath).text();

      const fixed = text.replace(
        /\/\/# sourceMappingURL=.*$/m,
        `//# sourceMappingURL=${basename(mapOut)}`,
      );

      await bun.write(outPath, fixed);
    }
  }

  if (existsSync(entryPath) && entryPath !== outPath) {
    rmSync(entryPath, { force: true });
  }

  const finalCode = existsSync(outPath) ? await bun.file(outPath).text() : code;

  const elapsed = (performance.now() - start).toFixed(2);

  ctx.logger.info(`Linked → ${outPath} (${(Buffer.byteLength(finalCode) / 1024).toFixed(1)} KB)`);

  ctx.logger.info(`linker completed in ${elapsed}ms`);

  return outPath;
};

/**
 * Sync fallback.
 *
 * Bun.build is async, so synchronous compile() cannot use it.
 * Prefer buildAsync() in production.
 */
export const runLinker = (code: string, opts: CompilerOptions, ctx: CompilerContext): string =>
  ctx.logger.time("linker", () => {
    mkdirSync(opts.outDir, { recursive: true });

    const outPath = join(opts.outDir, opts.outFile);

    return writeRaw(
      outPath,
      code,
      ctx,
      "Sync linker wrote unminified output. Use buildAsync() for Bun.build minification.",
    );
  });

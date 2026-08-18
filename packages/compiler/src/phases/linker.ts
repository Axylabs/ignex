/**
 * Phase 5: LINKER — Bun 1.4 edition.
 *
 * Important:
 * - The temporary Bun.build entry MUST live in opts.outDir.
 * - Generated import paths are relative to opts.outDir.
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { DiagnosticCodes, errorMessage } from "../diagnostics";
import type { CompilerContext, CompilerOptions } from "../types";

/** Minimal Bun.build log shape (message + optional source position). */
interface BunBuildLog {
  readonly message?: string;
  readonly position?: { readonly file?: string; readonly line?: number; readonly column?: number };
}

/** Minimal Bun.build result surface the linker reads. */
interface BunBuildResult {
  readonly success: boolean;
  readonly logs?: readonly BunBuildLog[];
  readonly outputs?: ReadonlyArray<{ readonly path?: string }>;
}

/** The small subset of the Bun runtime the linker uses. */
interface BunRuntime {
  build(opts: unknown): Promise<BunBuildResult>;
  write(path: string, data: string): Promise<number>;
  file(path: string): { text(): Promise<string> };
}

export const formatBuildLogs = (input: unknown): string => {
  const raw = Array.isArray(input)
    ? input
    : input && typeof input === "object" && "logs" in input
      ? ((input as { logs?: unknown }).logs ?? [])
      : [];
  const logs = Array.isArray(raw) ? raw : [];

  if (logs.length === 0) return "";

  return (
    "\n" +
    logs
      .map((log) => {
        if (typeof log === "string") return log;
        if (typeof log !== "object" || log === null) return String(log);
        const entry = log as BunBuildLog;
        const pos = entry.position
          ? ` (${entry.position.file}:${entry.position.line}:${entry.position.column})`
          : "";
        return `${entry.message ?? String(log)}${pos}`;
      })
      .join("\n")
  );
};

const bun = (globalThis as { Bun?: BunRuntime }).Bun;

/** Recursively pull `errors`/`logs` off an unknown Bun.build failure. */
const errorLogs = (err: unknown): unknown => {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { errors?: unknown; logs?: unknown; cause?: unknown };
  if (e.errors) return e.errors;
  if (e.logs) return e.logs;
  return errorLogs(e.cause);
};

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

/** Run Bun.build, reporting failures as diagnostics. Returns `null` on failure. */
const buildWithFallback = async (
  entryPath: string,
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<BunBuildResult | null> => {
  const buildOptions: Record<string, unknown> = {
    entrypoints: [entryPath],
    outdir: opts.outDir,
    target: "bun",
    format: "esm",
    minify: opts.minify,
    sourcemap: opts.sourceMap ? "external" : "none",
  };

  // `runLinkerAsync` guards `bun?.build` before calling us — capture the
  // narrowed function so the build path never re-checks an optional Bun.
  const build = bun?.build;
  if (!build) return null;

  try {
    const result = await build(buildOptions);
    if (!result.success) {
      const message = (result.logs ?? []).map((log) => log.message ?? String(log)).join("\n");
      rmSync(entryPath, { force: true });
      ctx.diagnostics.error({
        code: DiagnosticCodes.LinkFailed,
        message: `Bun.build failed: ${message}`,
      });
      return null;
    }
    return result;
  } catch (err: unknown) {
    rmSync(entryPath, { force: true });

    const details = formatBuildLogs(errorLogs(err));

    ctx.diagnostics.error({
      code: DiagnosticCodes.LinkFailed,
      message: `Bun.build threw an exception: ${errorMessage(err)}${details}`,
    });

    return null;
  }
};

/** Move the built output (or the entry file) to the final outPath. */
const relocateOutput = (
  builtPath: string | undefined,
  entryPath: string,
  outPath: string,
): void => {
  if (builtPath && existsSync(builtPath)) {
    if (builtPath !== outPath) {
      renameSync(builtPath, outPath);
    }
  } else if (existsSync(entryPath)) {
    if (entryPath !== outPath) {
      renameSync(entryPath, outPath);
    }
  }
};

/** Rewrite the sourcemap comment to point at the final output file. */
const fixSourceMap = async (
  opts: CompilerOptions,
  builtPath: string | undefined,
  entryPath: string,
  outPath: string,
): Promise<void> => {
  if (!opts.sourceMap) return;

  const mapSource = builtPath ? `${builtPath}.map` : `${entryPath}.map`;
  const mapOut = `${outPath}.map`;

  if (existsSync(mapSource) && mapSource !== mapOut) {
    renameSync(mapSource, mapOut);
  }

  if (existsSync(outPath)) {
    const file = bun?.file(outPath);
    if (!file) return;
    const text = await file.text();
    const fixed = text.replace(
      /\/\/# sourceMappingURL=.*$/m,
      `//# sourceMappingURL=${basename(mapOut)}`,
    );
    await bun?.write(outPath, fixed);
  }
};

/** Remove the temporary entry file when it is not the final output. */
const cleanupEntry = (entryPath: string, outPath: string): void => {
  if (existsSync(entryPath) && entryPath !== outPath) {
    rmSync(entryPath, { force: true });
  }
};

/**
 * Resolve the output path for a standalone executable. `binaryOutfile` is
 * rooted under `outDir` when relative; defaults to `join(outDir, serviceName)`.
 */
const binaryOutPath = (opts: CompilerOptions): string => {
  if (opts.binaryOutfile) {
    return isAbsolute(opts.binaryOutfile)
      ? opts.binaryOutfile
      : join(opts.outDir, opts.binaryOutfile);
  }
  return join(opts.outDir, opts.serviceName ?? "ignex");
};

/**
 * Build the standalone executable (`Bun.build` with `compile`) from the temp
 * entry. Pins production defaults: minify, bytecode, linked sourcemap, and
 * `NODE_ENV=production` (inlined, enabling dead-code elimination). Returns
 * `null` on failure after reporting a `LinkFailed` diagnostic.
 */
const buildCompiled = async (
  entryPath: string,
  outfile: string,
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<BunBuildResult | null> => {
  const buildOptions: Record<string, unknown> = {
    entrypoints: [entryPath],
    compile: {
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "linked",
    bytecode: opts.bytecode ?? true,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  };

  const build = bun?.build;
  if (!build) return null;

  try {
    const result = await build(buildOptions);
    if (!result.success) {
      const message = (result.logs ?? []).map((log) => log.message ?? String(log)).join("\n");
      rmSync(entryPath, { force: true });
      ctx.diagnostics.error({
        code: DiagnosticCodes.LinkFailed,
        message: `Bun.build (compile) failed: ${message}`,
      });
      return null;
    }
    return result;
  } catch (err: unknown) {
    rmSync(entryPath, { force: true });
    const details = formatBuildLogs(errorLogs(err));
    ctx.diagnostics.error({
      code: DiagnosticCodes.LinkFailed,
      message: `Bun.build (compile) threw an exception: ${errorMessage(err)}${details}`,
    });
    return null;
  }
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

  // Standalone executable: embed the Bun runtime + bytecode so the binary can
  // be deployed without installing Bun. `compile` has no `outdir` — output is
  // pinned to `binaryOutfile ?? join(outDir, serviceName)`.
  if (opts.compile) {
    const compileOut = binaryOutPath(opts);
    const entryPath = join(opts.outDir, `.${opts.outFile}.entry.js`);
    await bun.write(entryPath, code);
    const result = await buildCompiled(entryPath, compileOut, opts, ctx);
    if (!result) return outPath; // LinkFailed diagnostic already reported
    cleanupEntry(entryPath, compileOut);

    const finalSize = existsSync(compileOut) ? statSync(compileOut).size : 0;
    const elapsed = (performance.now() - start).toFixed(2);
    ctx.logger.info(
      `Compiled → ${compileOut} (${(finalSize / (1024 * 1024)).toFixed(1)} MB, bytecode=${opts.bytecode ?? true})`,
    );
    ctx.logger.info(`linker completed in ${elapsed}ms`);
    return outPath;
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
   *   dist/.ignex-link/__server.js
   *
   * Because generated imports are relative to dist/.
   */
  const entryPath = join(opts.outDir, `.${opts.outFile}.entry.js`);

  await bun.write(entryPath, code);

  const result = await buildWithFallback(entryPath, opts, ctx);
  if (!result) return outPath;

  const builtPath: string | undefined = result.outputs?.[0]?.path;
  relocateOutput(builtPath, entryPath, outPath);
  await fixSourceMap(opts, builtPath, entryPath, outPath);
  cleanupEntry(entryPath, outPath);

  const finalCode = existsSync(outPath) ? await bun.file(outPath).text() : code;

  const elapsed = (performance.now() - start).toFixed(2);

  ctx.logger.info(`Linked → ${outPath} (${(Buffer.byteLength(finalCode) / 1024).toFixed(1)} KB)`);

  ctx.logger.info(`linker completed in ${elapsed}ms`);

  return outPath;
};

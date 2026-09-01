/**
 * Phase 5: LINKER — Bun 1.4 edition.
 *
 * Important:
 * - The temporary Bun.build entry MUST live in opts.outDir.
 * - Generated import paths are relative to opts.outDir.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { DiagnosticCodes, errorMessage } from "../diagnostics";
import type { CompilerContext, CompilerOptions } from "../types";
import { projectPath } from "../utils/path";
import { isProductionBuild } from "./analysis/app-config";
import { debugbarStubRewrite } from "./analysis/dev-only-plugins";
import { writeIfChanged } from "./artifacts/write";

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

  // Content-diffed: an identical rebuild must not churn the output file's
  // mtime (watchers, containers, and downstream SDK tooling all key on it).
  if (writeIfChanged(outPath, code)) {
    ctx.logger.info(`Linked → ${outPath} (${(Buffer.byteLength(code) / 1024).toFixed(1)} KB)`);
  }

  return outPath;
};

/**
 * Extract unresolvable bare specifiers from Bun.build failure logs
 * (`Could not resolve: "x"`). These become `external` for a single retry, so
 * an optional/uninstalled dependency referenced by route code degrades to
 * runtime resolution instead of failing the build.
 */
const unresolvedSpecifiers = (logs: readonly BunBuildLog[]): string[] => {
  const out = new Set<string>();
  for (const log of logs) {
    const m = /Could not resolve:\s+"([^"]+)"/.exec(log.message ?? "");
    if (m?.[1] && !m[1].startsWith(".") && !m[1].startsWith("/")) out.add(m[1]);
  }
  return [...out];
};

/**
 * Bun.build loader plugin that PREPENDS `globalThis.__IGNEX_PROD_BUILD = true`
 * to the app-config module in production-shaped builds, and rewrites the
 * module's `debugbar` import bindings to inert local stubs so the bundler
 * treeshakes the entire debug graph (dashboard SPA, observatory endpoints,
 * TraceStore) out of the artifact.
 *
 * The assignment must live inside the app-config module itself (not the
 * generated entry header): ESM import hoisting evaluates the plugins array —
 * and with it every `debugbar(...)` factory call — before any entry-level
 * statement runs, so a header flag would always be set too late. Returns
 * `undefined` when the build is not production-shaped or no app config exists,
 * so the linker emits no plugin at all.
 */
const prodShapeBunPlugin = (
  appConfigAbs: string,
  isProdBuild: boolean,
): {
  name: string;
  setup: (build: { onLoad: (o: unknown, cb: unknown) => void }) => void;
} | null => {
  if (!isProdBuild || !existsSync(appConfigAbs)) return null;
  return {
    name: "ignex-prod-shape",
    setup(build) {
      build.onLoad({ filter: /\.(ts|js|tsx|jsx|mts|mjs)$/ }, (args: { path: string }) => {
        if (args.path !== appConfigAbs) return undefined;
        const contents = readFileSync(args.path, "utf8");
        // Stub the dev-only plugin FIRST (offsets are relative to the raw
        // file), then prepend the runtime shape flag.
        const rewritten = debugbarStubRewrite(contents) ?? contents;
        return {
          contents: `globalThis.__IGNEX_PROD_BUILD = true;\n${rewritten}`,
          loader: "ts",
        };
      });
    },
  };
};

/**
 * Bundle with externalization retry: when route code references packages that
 * cannot be resolved at build time (optional/uninstalled deps), externalize
 * exactly those specifiers and retry. Bun.build surfaces resolution failures
 * in waves (deeper modules only after shallower ones resolve), so this loops
 * until success or no NEW unresolved specifiers appear.
 */
const bundleWithExternalsRetry = async (
  build: (options: Record<string, unknown>) => Promise<BunBuildResult>,
  base: Record<string, unknown>,
  ctx: CompilerContext,
): Promise<{ result: BunBuildResult | null; thrown: unknown }> => {
  const externals = new Set<string>();
  let result: BunBuildResult | null = null;
  let thrown: unknown = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    thrown = null;
    result = null;
    try {
      result = (await build({
        ...base,
        ...(externals.size > 0 ? { external: [...externals] } : {}),
      })) as BunBuildResult;
    } catch (err: unknown) {
      thrown = err;
    }
    if (result?.success) break;

    const missing = [
      ...new Set([
        ...(result && !result.success ? unresolvedSpecifiers(result.logs ?? []) : []),
        ...(thrown !== null
          ? unresolvedSpecifiers((errorLogs(thrown) as BunBuildLog[] | undefined) ?? [])
          : []),
      ]),
    ].filter((spec) => !externals.has(spec));
    if (missing.length === 0) break;

    ctx.diagnostics.warn({
      code: DiagnosticCodes.LinkFailed,
      message: `Unresolved package${missing.length > 1 ? "s" : ""} externalized (must resolve at runtime): ${missing.join(", ")}`,
    });
    for (const spec of missing) externals.add(spec);
  }

  return { result, thrown };
};

/** Build the JS artifact, reporting failures as diagnostics. */
const buildWithFallback = async (
  entryPath: string,
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<BunBuildResult | null> => {
  // Production-shaped builds bake their shape into the app-config module so
  // dev-only plugins (debugbar) inert-construct themselves even when the
  // artifact is launched without `NODE_ENV=production` in the environment.
  const appConfigAbs =
    typeof opts.appConfig === "string" && opts.appConfig.length > 0
      ? projectPath(opts.appConfig)
      : projectPath("./src/app.config.ts");
  const prodShapePlugin = prodShapeBunPlugin(appConfigAbs, isProductionBuild(opts));

  const base: Record<string, unknown> = {
    entrypoints: [entryPath],
    outdir: opts.outDir,
    target: "bun",
    format: "esm",
    minify: opts.minify,
    sourcemap: opts.sourceMap ? "external" : "none",
    ...(prodShapePlugin ? { plugins: [prodShapePlugin] } : {}),
  };

  // `runLinkerAsync` guards `bun?.build` before calling us — capture the
  // narrowed function so the build path never re-checks an optional Bun.
  const build = bun?.build;
  if (!build) return null;

  const fail = (message: string): null => {
    rmSync(entryPath, { force: true });
    ctx.diagnostics.error({ code: DiagnosticCodes.LinkFailed, message });
    return null;
  };

  // Bundle everything, externalizing unresolvable packages wave by wave.
  const { result, thrown } = await bundleWithExternalsRetry(build, base, ctx);

  if (result?.success) return result;

  if (thrown !== null) {
    const details = formatBuildLogs(errorLogs(thrown));
    return fail(`Bun.build threw an exception: ${errorMessage(thrown)}${details}`);
  }

  return fail(
    `Bun.build failed: ${(result?.logs ?? []).map((log) => log.message ?? String(log)).join("\n")}`,
  );
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
  // Standalone binaries embed EVERYTHING (user deps included) — that is their
  // purpose: deploy without installing Bun or node_modules. No externals.
  const options: Record<string, unknown> = {
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
    const result = await build(options);
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

  /**
   * ALWAYS bundle (dev included): the linker compiles route modules, hooks,
   * validators/serializers and generated helpers into ONE self-contained
   * artifact. Bun.build performs treeshaking + dead-code elimination over the
   * whole module graph, so unreferenced runtime helpers and core exports are
   * removed by the bundler — no hand-rolled usage tracking anywhere.
   *
   * `minify` only controls identifier compression; treeshaking is inherent to
   * bundling and always on.
   *
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

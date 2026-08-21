/**
 * Ignex Compiler Orchestrator — Bun 1.4 edition.
 *
 * The compiler follows a Svelte-style phased pipeline:
 *
 *   discovery → analysis → optimization → (precompile validators/serializers)
 *       → codegen → linker → artifacts
 *
 * Every phase receives a {@link CompilerContext} carrying a `Logger` sink and a
 * `DiagnosticCollector`, so problems are surfaced as structured diagnostics
 * (code + severity + position + frame) instead of being silently swallowed.
 *
 * The async path (`buildAsync` / `compileAsync`) is the canonical, fully
 * featured entry point. The old sync path (`build` / `compile`) was removed —
 * it could not precompile validators/serializers, minify, or emit source maps.
 */

import { pipeAsync } from "@ignex/shared";
import { computeRouteChanges, tryCachedBuild } from "./cache";
import {
  DiagnosticCodes,
  DiagnosticCollector,
  errorMessage,
  reportDiagnostics,
} from "./diagnostics";
import { SourceManager } from "./frontend";
import { loadPersistedModules, persistModules } from "./frontend/persist";
import type { Logger } from "./logger";
import { consoleLogger } from "./logger";
import {
  analysisStage,
  artifactsStage,
  cacheStage,
  codegenStage,
  discoveryStage,
  finish,
  linkStage,
  optimizationStage,
  type PipelineState,
  precompileStage,
} from "./pipeline";
import type { CompileResult, CompilerContext, CompilerOptions } from "./types";
import { DEFAULT_OPTS } from "./types";
import { mergeOptions, validateOptions } from "./validate";

export {
  computeRouteChanges,
  computeRouteFingerprint,
  diffRouteFingerprints,
  fingerprintRouteFiles,
  type RouteChangeSet,
  type RouteFingerprint,
} from "./cache";
export {
  type Diagnostic,
  DiagnosticCodes,
  formatDiagnostic,
  getCodeFrame,
} from "./diagnostics";
export {
  generateClient,
  generateClientDts,
  generateManifest,
  generateOpenApi,
  generateRouteTypes,
  writeArtifacts,
} from "./phases/artifacts";
// Route/OpenAPI helpers are part of the public surface so consumers (e.g. the
// standalone `scripts/generate-openapi-client.ts`) can share the canonical
// implementations instead of re-implementing (and drifting from) them.
export { parseRouteFilename } from "./phases/discovery";
// SDK generation pipeline — multi-platform SDK packages derived from the
// compiled artifacts (see `sdk/`); consumed by `ignex sdk` and
// `scripts/generate-sdk.ts`.
export {
  DEFAULT_SDK_PLATFORMS,
  generateSdk,
  packSdk,
  sdkPlatforms,
  writeSdk,
} from "./sdk";
export type { JsonSchemaToTsOptions } from "./sdk/json-schema-to-ts";
export { loadSdkInputs } from "./sdk/load";
export type {
  SdkGithubReleaseOptions,
  SdkNpmPublishOptions,
  SdkTagOptions,
} from "./sdk/publish";
export {
  createSdkGithubRelease,
  publishSdkToNpm,
  resolveRepoUrl,
  tagSdkVersion,
} from "./sdk/publish";
export type {
  SdkFile,
  SdkGenerateContext,
  SdkOptions,
  SdkPackage,
  SdkPlatform,
  SdkPlatformId,
  SdkResult,
  SdkRouteInfo,
} from "./sdk/types";
export type { CompileResult, CompilerOptions, RouteIR } from "./types";
export { DEFAULT_OPTS, mergeOptions };

/** Build a fresh per-compile context (logger + diagnostic collector). */
const createContext = (logger: Logger): CompilerContext => ({
  logger,
  diagnostics: new DiagnosticCollector(),
});

/**
 * Thrown when a compile fails option validation or produces error-level
 * diagnostics. Carries a machine `code` and the compiler `diagnostics` so
 * programmatic callers can branch without string-matching the message.
 */
export class CompilationError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_OPTIONS" | "COMPILE_FAILED",
    public readonly diagnostics: readonly import("./diagnostics").Diagnostic[],
  ) {
    super(message);
    this.name = "CompilationError";
  }
}

/**
 * Per-compile orchestrator.
 *
 * Threads a `CompilerContext` (logger + diagnostics) through the full phase
 * pipeline — discovery → analysis → optimization → precompile → artifacts →
 * codegen → link → cache. The canonical entry point is {@link compileAsync}.
 *
 * @param input - Partial {@link CompilerOptions}; validated + defaulted on
 * each compile via `validateOptions`.
 */
export class IgnexCompiler {
  constructor(private readonly input: Partial<CompilerOptions> = {}) {}

  /** Canonical async compile with validator/serializer precompilation. */
  async compileAsync(): Promise<CompileResult> {
    const ctx = createContext(consoleLogger(this.input.verbose ?? false));
    const validated = validateOptions(this.input, ctx.diagnostics);

    if (!validated.ok) {
      // Surface deprecation/unknown-option diagnostics even when validation
      // fails, so option drift is visible instead of a bare throw.
      reportDiagnostics(ctx.diagnostics.all, ctx.logger);
      throw new CompilationError(
        `Compiler options invalid:\n${validated.error.join("\n")}`,
        "INVALID_OPTIONS",
        ctx.diagnostics.all,
      );
    }

    const opts = validated.value;
    const t0 = performance.now();

    // Seed discovery with the persistent parse cache so unchanged modules skip
    // re-parsing on both cache-hit artifact regeneration and full rebuilds.
    const diskCache = opts.incremental ? loadPersistedModules(opts.outDir) : new Map();
    const sources = new SourceManager(diskCache);

    ctx.logger.info("ignex compiler started (async)", {
      target: opts.target,
      optimizationLevel: opts.optimizationLevel,
      routesDir: opts.routesDir,
      outDir: opts.outDir,
    });

    // Incremental fast path: reuse the previous build when nothing changed.
    let routeChanges: ReturnType<typeof computeRouteChanges>;
    if (opts.incremental) {
      const cached = await tryCachedBuild(opts, ctx);
      if (cached) {
        // Artifacts (openapi.json, client.ts/d.ts, routes.d.ts) are NOT stored
        // in the cache, so on a cache hit they could go stale or go missing.
        // Regenerate them from a fresh discovery/analysis (skipping the
        // expensive codegen + link steps) whenever artifact generation is on.
        // `precompileStage` MUST run too: it is what populates
        // `decisions.schemaDoc` (validators/serializers → OpenAPI), so without
        // it the regenerated openapi.json silently loses request/response
        // schemas and the SDK/client types drift from the served API.
        if (opts.generateTypes || opts.generateOpenAPI || opts.generateClient) {
          const state = (await pipeAsync({ opts, ctx, t0, routes: [], sources } as PipelineState)(
            discoveryStage,
            analysisStage,
            optimizationStage,
            precompileStage,
            artifactsStage,
          )) as PipelineState;

          // Self-heal the module parse cache on cache hits too — a cache hit
          // re-parses when the file is missing, so persist the result.
          try {
            if (state.discovery?.sources) {
              persistModules(state.discovery.sources.all(), opts.outDir);
            }
          } catch (error) {
            ctx.diagnostics.warn({
              code: DiagnosticCodes.BuildCacheInvalid,
              message: `Failed to write module parse cache: ${errorMessage(error)}`,
            });
          }
        }
        const elapsed = performance.now() - t0;
        return finish({
          code: cached.code,
          outPath: cached.outFile,
          ctx,
          elapsed,
          cached: true,
          meta: cached.meta,
        });
      }

      // Whole-build cache miss: report exactly which route files changed since
      // the last build. This is the parse-level incrementality foundation — a
      // later increment re-emits only these routes instead of the whole build.
      routeChanges = computeRouteChanges(opts);
      if (routeChanges && routeChanges.changed.length > 0) {
        ctx.logger.info(
          `Incremental build — ${routeChanges.changed.length} route(s) changed: ${routeChanges.changed.join(", ")}`,
        );
      }
    } else {
      // Non-incremental full build: compute the change set once for metadata.
      routeChanges = computeRouteChanges(opts);
    }

    const state = (await pipeAsync({ opts, ctx, t0, routes: [], sources } as PipelineState)(
      discoveryStage,
      analysisStage,
      optimizationStage,
      precompileStage,
      artifactsStage,
      codegenStage,
      linkStage,
      cacheStage,
    )) as PipelineState;

    const elapsed = performance.now() - t0;

    if (ctx.diagnostics.hasErrors) {
      const summary = ctx.diagnostics.errors.map((d) => `  - ${d.code}: ${d.message}`).join("\n");

      throw new CompilationError(
        `Compilation failed with ${ctx.diagnostics.errors.length} error(s):\n${summary}`,
        "COMPILE_FAILED",
        ctx.diagnostics.all,
      );
    }

    return finish({
      code: state.code as string,
      outPath: state.outPath as string,
      ctx,
      elapsed,
      meta: state.meta,
      changedRoutes: routeChanges?.changed,
    });
  }
}

/**
 * Top-level convenience: compile once and return the {@link CompileResult}.
 *
 * Equivalent to `new IgnexCompiler(opts).compileAsync()`. Throws an `Error`
 * with a summary of validation/compile diagnostics on failure.
 *
 * @param opts - Partial {@link CompilerOptions}.
 * @returns The structured compile result.
 */
export async function buildAsync(opts?: Partial<CompilerOptions>): Promise<CompileResult> {
  return new IgnexCompiler(opts).compileAsync();
}

if (import.meta.main) {
  await buildAsync();
}

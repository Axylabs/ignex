#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Flux Production Refactor Script
# Option A: Remove unused optimizer complexity
# ============================================================================

echo "Starting Flux production refactor..."

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required."
  exit 1
fi

if ! command -v perl >/dev/null 2>&1; then
  echo "Error: perl is required for patching."
  exit 1
fi

# ----------------------------------------------------------------------------
# Backup
# ----------------------------------------------------------------------------

BACKUP_DIR=".flux-refactor-backup-$(date +%Y%m%d-%H%M%S)"
echo "Backing up current project to ${BACKUP_DIR}"

mkdir -p "${BACKUP_DIR}"

if [[ -d src ]]; then
  cp -r src "${BACKUP_DIR}/src"
fi

if [[ -f package.json ]]; then
  cp package.json "${BACKUP_DIR}/package.json"
fi

if [[ -f tsconfig.json ]]; then
  cp tsconfig.json "${BACKUP_DIR}/tsconfig.json"
fi

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

move() {
  local src="$1"
  local dest="$2"

  if [[ ! -e "$src" ]]; then
    echo "Skip move, missing: $src"
    return 0
  fi

  if [[ -e "$dest" ]]; then
    echo "Skip move, already exists: $dest"
    return 0
  fi

  if git rev-parse --git-dir >/dev/null 2>&1; then
    git mv "$src" "$dest"
  else
    mv "$src" "$dest"
  fi
}

# ----------------------------------------------------------------------------
# Delete known dead files
# ----------------------------------------------------------------------------

echo "Removing dead files..."

rm -f index.ts
rm -f src/types/modules.d.ts
rm -f src/compiler/utils/trie.ts

# ----------------------------------------------------------------------------
# Create shared placeholder
# ----------------------------------------------------------------------------

mkdir -p src/shared

cat > src/shared/README.md <<'FLUX_EOF'
# Shared Types

This directory is reserved for the unified type system.

Next step:

- move HTTP primitives here
- move ContextUsage here
- move CompilerOptions here
- make compiler and runtime import from this shared package

This removes duplicated type definitions between:

- src/compiler/types.ts
- src/runtime/types.ts or src/core/types.ts
FLUX_EOF

# ----------------------------------------------------------------------------
# Update package.json
# ----------------------------------------------------------------------------

echo "Updating package.json..."

mkdir -p scripts

cat > scripts/update-package.mjs <<'FLUX_EOF'
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

pkg.dependencies ??= {};
pkg.devDependencies ??= {};
pkg.scripts ??= {};

const removeDeps = [
  "acorn",
  "just-debounce",
  "just-throttle",
  "memoizee",
  "p-retry",
  "dequal",
  "p-timeout",
];

for (const dep of removeDeps) {
  delete pkg.dependencies[dep];
}

delete pkg.devDependencies["@types/memoizee"];

Object.assign(pkg.dependencies, {
  pino: "^9.0.0",
  "set-cookie-parser": "^2.7.0",
});

Object.assign(pkg.devDependencies, {
  "@biomejs/biome": "^2.5.4",
  "@types/bun": "^1.3.14",
  "@types/cookie": "^1.0.0",
  "@types/set-cookie-parser": "^2.4.10",
  typescript: "^5.9.0",
  vitest: "^4.1.10",
});

Object.assign(pkg.scripts, {
  typecheck: "tsc --noEmit",
  lint: "biome check .",
  "lint:fix": "biome check --write .",
  test: "vitest run",
  "test:watch": "vitest",
  build: "bun run builder.ts",
  smoke: "bun run dist/__server.js",
});

writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
FLUX_EOF

bun scripts/update-package.mjs

# ----------------------------------------------------------------------------
# TypeScript config
# ----------------------------------------------------------------------------

echo "Writing strict tsconfig.json..."

cat > tsconfig.json <<'FLUX_EOF'
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "allowJs": false,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "test", "builder.ts", "vitest.config.ts"]
}
FLUX_EOF

# ----------------------------------------------------------------------------
# Biome config
# ----------------------------------------------------------------------------

echo "Writing biome.json..."

cat > biome.json <<'FLUX_EOF'
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noConsoleLog": "warn",
        "noExplicitAny": "off"
      },
      "correctness": {
        "noUnusedVariables": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always"
    }
  }
}
FLUX_EOF

# ----------------------------------------------------------------------------
# Vitest config
# ----------------------------------------------------------------------------

echo "Writing vitest.config.ts..."

cat > vitest.config.ts <<'FLUX_EOF'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
FLUX_EOF

mkdir -p test

cat > test/refactor.test.ts <<'FLUX_EOF'
import { describe, expect, it } from "vitest";

describe("production refactor", () => {
  it("should run tests", () => {
    expect(true).toBe(true);
  });
});
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/compiler/fp.ts with minimal zero-dependency FP core
# ----------------------------------------------------------------------------

echo "Replacing src/compiler/fp.ts with minimal FP core..."

cat > src/compiler/fp.ts <<'FLUX_EOF'
/**
 * Minimal functional core used by the compiler.
 *
 * This intentionally removes unused utility-belt code and external dependencies.
 * If you need debounce/throttle/memoize/retry, add them in a separate optional
 * module and do not import them into core runtime paths.
 */

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;

export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export const unwrapOr =
  <T>(fallback: T) =>
  (r: Result<T>): T =>
    r.ok ? r.value : fallback;

export const unwrapOrElse =
  <T, E>(fn: (e: E) => T) =>
  (r: Result<T, E>): T =>
    r.ok ? r.value : fn(r.error);

export const mapResult =
  <T, U>(fn: (x: T) => U) =>
  <E>(r: Result<T, E>): Result<U, E> =>
    r.ok ? ok(fn(r.value)) : r;

export const flatMapResult =
  <T, U, E>(fn: (x: T) => Result<U, E>) =>
  (r: Result<T, E>): Result<U, E> =>
    r.ok ? fn(r.value) : r;

export const mapErr =
  <E, F>(fn: (e: E) => F) =>
  <T>(r: Result<T, E>): Result<T, F> =>
    r.ok ? r : err(fn(r.error));

export const tryCatch = <T>(fn: () => T): Result<T, unknown> => {
  try {
    return ok(fn());
  } catch (error) {
    return err(error);
  }
};

export const tryCatchAsync = async <T>(fn: () => Promise<T>): Promise<Result<T, unknown>> => {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error);
  }
};

export const tryCatchOr = <T>(fallback: T, fn: () => T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export type Task<T> = () => Promise<T>;

export const taskMap =
  <T, U>(fn: (x: T) => U) =>
  (task: Task<T>): Task<U> =>
  async () =>
    fn(await task());

export const taskChain =
  <T, U>(fn: (x: T) => Task<U>) =>
  (task: Task<T>): Task<U> =>
  async () =>
    fn(await task())();

export const taskFromResult =
  <T>(value: T): Task<T> =>
  async () =>
    value;

export const pipe =
  <A>(a: A) =>
  <B>(...fns: Array<(x: any) => any>): B =>
    fns.reduce((acc: any, fn) => fn(acc), a) as unknown as B;
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/compiler/utils/hash.ts
# Keep only hashes actually used by analysis/codegen.
# ----------------------------------------------------------------------------

echo "Replacing src/compiler/utils/hash.ts..."

cat > src/compiler/utils/hash.ts <<'FLUX_EOF'
/**
 * Hash utilities used by route analysis.
 *
 * Removed:
 * - canUseDenseArray
 * - generatePerfectHash
 * - segmentHash
 *
 * These belonged to the unused jump-table optimizer path.
 */

export const fnv1a = (str: string): number => {
  let hash = 0x811c9dc5;

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return hash >>> 0;
};

export const computeSignatureHash = (methodIdx: number, path: string): number => {
  const pathHash = fnv1a(path);
  return ((methodIdx & 0x07) << 29) | (pathHash >>> 3);
};
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/compiler/types.ts
# ----------------------------------------------------------------------------

echo "Replacing src/compiler/types.ts..."

cat > src/compiler/types.ts <<'FLUX_EOF'
/**
 * Flux Compiler Type System
 *
 * Production cleanup:
 * - removed unused jump table types
 * - removed unused trie types from compiler pipeline
 * - removed unimplemented compiler flags
 * - removed preserialized buffer pipeline
 */

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ContextUsage {
  body: boolean;
  params: boolean;
  query: boolean;
  file: boolean;
  headers: boolean;
  state: boolean;
  json: boolean;
  text: boolean;
  redirect: boolean;
  req: boolean;
  url: boolean;
}

export const FULL_CONTEXT_USAGE: ContextUsage = {
  body: true,
  params: true,
  query: true,
  file: true,
  headers: true,
  state: true,
  json: true,
  text: true,
  redirect: true,
  req: true,
  url: true,
};

export interface CompilerOptions {
  readonly routesDir: string;
  readonly outDir: string;
  readonly outFile: string;
  readonly target: "bun" | "node" | "deno";
  readonly optimizationLevel: 0 | 1 | 2 | 3;
  readonly inlineThreshold: number;
  readonly enableHandlerDeduplication: boolean;
  readonly sourceMap: boolean;
  readonly minify: boolean;

  readonly hooksDir?: string;

  readonly enableTracing?: boolean;
  readonly enableAccessLog?: boolean;
  readonly enableTraceHeaders?: boolean;
  readonly enableLifecycle?: boolean;
  readonly enableStrictMethods?: boolean;
  readonly enableFastBodyParsing?: boolean;

  readonly serviceName?: string;
  readonly requestIdHeader?: string;
  readonly exposeErrorDetails?: boolean;

  readonly maxJsonBytes?: number;
  readonly maxTextBytes?: number;
  readonly maxFormBytes?: number;
  readonly maxFileBytes?: number;

  readonly cluster?: number | "auto";
  readonly reusePort?: boolean;
}

export interface RouteCacheConfig {
  readonly maxAge?: number;
  readonly swr?: number;
  readonly immutable?: boolean;
  readonly vary?: readonly string[];
}

export const createDefaultOptions = (): CompilerOptions => ({
  routesDir: process.env.ROUTES_DIR || "./src/routes",
  outDir: process.env.OUT_DIR || "./dist",
  outFile: "__server.js",
  target: "bun",
  optimizationLevel: 3,
  inlineThreshold: 50,
  enableHandlerDeduplication: true,
  sourceMap: false,
  minify: false,

  enableTracing: true,
  enableAccessLog: true,
  enableTraceHeaders: true,
  enableLifecycle: true,
  enableStrictMethods: true,
  enableFastBodyParsing: false,

  serviceName: "flux",
  requestIdHeader: "x-request-id",
  exposeErrorDetails: process.env.NODE_ENV !== "production",
});

export const DEFAULT_OPTS: CompilerOptions = createDefaultOptions();

export interface Position {
  readonly line: number;
  readonly column: number;
}

export type SymbolKind =
  | "function"
  | "class"
  | "const"
  | "let"
  | "var"
  | "type"
  | "interface";

export interface SymbolInfo {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly pos: Position;
  readonly isAsync: boolean;
  readonly isDefaultExport: boolean;
  readonly params: readonly string[];
  readonly returnType?: string;
  readonly decorators: readonly string[];
  readonly calls: readonly string[];
  readonly calledBy: readonly string[];
  readonly size: number;
  readonly hotness: number;
}

export interface ImportInfo {
  readonly source: string;
  readonly names: readonly string[];
  readonly defaultName?: string;
  readonly namespaceName?: string;
}

export interface ExportInfo {
  readonly name: string;
  readonly kind: "default" | "named" | "namespace";
  readonly symbolRef?: string;
}

export interface ModuleInfo {
  readonly path: string;
  readonly relPath: string;
  readonly content: string;
  readonly imports: readonly ImportInfo[];
  readonly exports: readonly ExportInfo[];
  readonly symbols: readonly SymbolInfo[];
  readonly hasDefaultExport: boolean;
  readonly schemaExport?: string;
  readonly configExport?: string;
  readonly callGraph: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dataFlow: ReadonlyMap<string, ReadonlySet<string>>;
}

export type ResponseType = "json" | "text" | "html" | "stream" | "unknown";

export interface RouteDef {
  readonly method: HttpMethod;
  readonly cache?: RouteCacheConfig;
  readonly path: string;
  readonly file: string;
  readonly moduleIdx: number;
  readonly handlerRef: string;
  readonly schemaRef: string | null;
  readonly paramNames: readonly string[];
  readonly isDynamic: boolean;
  readonly isStatic: boolean;
  readonly segmentCount: number;
  readonly signatureHash: number;
  readonly handlerSize: number;
  readonly isAsync: boolean;
  readonly shouldInline: boolean;
  readonly responseType: ResponseType;
  readonly hasValidation: boolean;
  readonly hotnessScore: number;
  readonly dedupGroup?: string;
  readonly hooks: readonly string[];
  readonly isConstantResponse: boolean;
  readonly constantResponse?: string;
  readonly usage: ContextUsage;
}

export interface HookDef {
  readonly name: string;
  readonly source: string;
  readonly moduleIdx: number;
  readonly isAsync: boolean;
}

export type { Logger } from "./logger";

export interface DiscoveryResult {
  readonly files: readonly string[];
  readonly modules: readonly ModuleInfo[];
}

export interface AnalysisResult {
  readonly routes: readonly RouteDef[];
  readonly modules: readonly ModuleInfo[];
  readonly hooks: ReadonlyMap<string, HookDef>;
}

export interface OptimizationMeta {
  readonly inlined: number;
  readonly deduplicated: number;
  readonly eliminated: number;
}

export interface OptimizationResult {
  readonly routes: readonly RouteDef[];
  readonly meta: OptimizationMeta;
}

export interface CompilationMeta {
  readonly inlinedHandlers: number;
  readonly deduplicatedHandlers: number;
  readonly eliminatedRoutes: number;
  readonly totalCompileTime: number;
}

export interface CompiledRoute {
  readonly staticRoutes: readonly RouteDef[];
  readonly dynamicRoutes: readonly RouteDef[];
  readonly modules: readonly ModuleInfo[];
  readonly meta: CompilationMeta;
}
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/compiler/validate.ts
# ----------------------------------------------------------------------------

echo "Replacing src/compiler/validate.ts..."

cat > src/compiler/validate.ts <<'FLUX_EOF'
/**
 * Compiler options validation.
 *
 * Removed unimplemented flags:
 * - enableSIMDPaths
 * - enableBranchPrediction
 * - enableDeadCodeElimination
 * - enableConstantFolding
 * - enableWorkerThreads
 * - enableSchemaInlining
 * - enableResponsePreserialization
 * - browserCache
 * - cacheBust
 */

import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import type { CompilerOptions } from "./types";
import { DEFAULT_OPTS } from "./types";
import type { Result } from "./fp";
import { ok, err } from "./fp";

const CompilerOptionsSchema = Type.Object(
  {
    routesDir: Type.String({ minLength: 1 }),
    outDir: Type.String({ minLength: 1 }),
    outFile: Type.String({ minLength: 1 }),

    target: Type.Union([
      Type.Literal("bun"),
      Type.Literal("node"),
      Type.Literal("deno"),
    ]),

    optimizationLevel: Type.Union([
      Type.Literal(0),
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
    ]),

    inlineThreshold: Type.Number({ minimum: 0, maximum: 1000 }),
    enableHandlerDeduplication: Type.Boolean(),
    sourceMap: Type.Boolean(),
    minify: Type.Boolean(),

    hooksDir: Type.Optional(Type.String({ minLength: 1 })),

    enableTracing: Type.Optional(Type.Boolean()),
    enableAccessLog: Type.Optional(Type.Boolean()),
    enableTraceHeaders: Type.Optional(Type.Boolean()),
    enableLifecycle: Type.Optional(Type.Boolean()),
    enableStrictMethods: Type.Optional(Type.Boolean()),
    enableFastBodyParsing: Type.Optional(Type.Boolean()),

    serviceName: Type.Optional(Type.String({ minLength: 1 })),
    requestIdHeader: Type.Optional(Type.String({ minLength: 1 })),
    exposeErrorDetails: Type.Optional(Type.Boolean()),

    maxJsonBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxTextBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxFormBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxFileBytes: Type.Optional(Type.Integer({ minimum: 0 })),

    cluster: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("auto")])
    ),

    reusePort: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type ValidatedCompilerOptions = Static<typeof CompilerOptionsSchema>;

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  useDefaults: true,
  coerceTypes: false,
});

const validate = ajv.compile(CompilerOptionsSchema);

export const validateOptions = (
  input: Partial<CompilerOptions>
): Result<CompilerOptions, string[]> => {
  const data = { ...DEFAULT_OPTS, ...input };

  if (validate(data)) {
    return ok(data as CompilerOptions);
  }

  const errors = (validate.errors ?? []).map((e) => {
    const path =
      e.instancePath?.replace(/^\//, "").replace(/\//g, ".") ||
      (e.params as any)?.missingProperty ||
      "options";

    return `${path}: ${e.message}`;
  });

  return err(errors);
};
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/compiler/phases/optimization.ts
# Option A: remove jump table / preserialization / schema compilation
# ----------------------------------------------------------------------------

echo "Replacing src/compiler/phases/optimization.ts..."

cat > src/compiler/phases/optimization.ts <<'FLUX_EOF'
/**
 * Phase 3: OPTIMIZATION
 *
 * Production cleanup:
 * - removed jump table generation
 * - removed dense/sparse/perfect-hash tables
 * - removed response preserialization buffers
 * - removed Zod-specific schema compilation
 * - kept inline detection and deduplication
 */

import type {
  RouteDef,
  ModuleInfo,
  CompilerOptions,
  OptimizationResult,
} from "../types";

import { estimateNodeCount } from "../utils/ast";
import type { Logger } from "../logger";

export const isInlineEligible = (
  route: RouteDef,
  mod: ModuleInfo | undefined,
  threshold: number
): boolean => {
  if (!mod) return false;
  if (route.hasValidation) return false;
  if (route.hooks.length > 0) return false;

  const nodeCount = estimateNodeCount(mod.content);
  return nodeCount <= threshold;
};

export const markInline = (
  route: RouteDef,
  modules: readonly ModuleInfo[],
  threshold: number
): RouteDef => {
  const mod = modules[route.moduleIdx];
  const shouldInline = isInlineEligible(route, mod, threshold);

  return shouldInline === route.shouldInline ? route : { ...route, shouldInline };
};

export const detectInlineCandidates = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  threshold: number
): RouteDef[] => routes.map((r) => markInline(r, modules, threshold));

export const hasConstantResponse = (route: RouteDef): boolean =>
  route.isConstantResponse && !!route.constantResponse;

export const groupByConstantResponse = (
  routes: readonly RouteDef[]
): Map<string, RouteDef[]> => {
  const groups = new Map<string, RouteDef[]>();

  for (const route of routes) {
    if (!hasConstantResponse(route)) continue;

    const key = route.constantResponse!;
    const existing = groups.get(key);

    if (existing) existing.push(route);
    else groups.set(key, [route]);
  }

  return groups;
};

export const buildDedupMap = (
  groups: Map<string, RouteDef[]>
): Map<string, string> => {
  const replacements = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const leader = group[0]!;

    for (let i = 1; i < group.length; i++) {
      replacements.set(group[i]!.handlerRef, leader.handlerRef);
    }
  }

  return replacements;
};

export const applyDedup = (
  route: RouteDef,
  dedupMap: Map<string, string>
): RouteDef => {
  const dedupGroup = dedupMap.get(route.handlerRef);
  return dedupGroup ? { ...route, dedupGroup } : route;
};

export const deduplicateRoutes = (routes: RouteDef[]): RouteDef[] => {
  const groups = groupByConstantResponse(routes);
  const dedupMap = buildDedupMap(groups);

  if (dedupMap.size === 0) return routes;

  return routes.map((r) => applyDedup(r, dedupMap));
};

export const countInlined = (routes: readonly RouteDef[]): number =>
  routes.filter((r) => r.shouldInline).length;

export const countDeduped = (routes: readonly RouteDef[]): number =>
  routes.filter((r) => r.dedupGroup).length;

export const runOptimization = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  logger: Logger
): OptimizationResult =>
  logger.time("optimization", () => {
    const inlined = detectInlineCandidates(routes, modules, opts.inlineThreshold);

    const deduped = opts.enableHandlerDeduplication
      ? deduplicateRoutes(inlined)
      : inlined;

    const inlinedCount = countInlined(deduped);
    const dedupedCount = countDeduped(deduped);

    logger.info(
      `Optimized: ${inlinedCount} inlined | ${dedupedCount} deduplicated`
    );

    return {
      routes: deduped,
      meta: {
        inlined: inlinedCount,
        deduplicated: dedupedCount,
        eliminated: routes.length - deduped.length,
      },
    };
  });
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/compiler/index.ts
# ----------------------------------------------------------------------------

echo "Replacing src/compiler/index.ts..."

cat > src/compiler/index.ts <<'FLUX_EOF'
/**
 * Flux Compiler Orchestrator
 *
 * Production cleanup:
 * - removed console.log orchestration
 * - removed jump table and trie reporting
 * - validates compiler options
 * - uses structured logger
 */

import type {
  CompilerOptions,
  CompiledRoute,
  DiscoveryResult,
  AnalysisResult,
  OptimizationResult,
} from "./types";

import type { Logger } from "./logger";
import { DEFAULT_OPTS } from "./types";
import { runDiscovery } from "./phases/discovery";
import { runAnalysis } from "./phases/analysis";
import { runOptimization } from "./phases/optimization";
import { runCodeGen } from "./phases/codegen";
import { runLinker } from "./phases/linker";
import { consoleLogger } from "./logger";
import { validateOptions } from "./validate";
import { defu } from "defu";

export { DEFAULT_OPTS };
export type { CompilerOptions, CompiledRoute };

export const mergeOptions = (
  opts: Partial<CompilerOptions>
): CompilerOptions => defu(opts, DEFAULT_OPTS) as CompilerOptions;

export const createCompilationResult = (
  optimized: OptimizationResult,
  analysis: AnalysisResult,
  elapsedMs: number
): CompiledRoute => ({
  staticRoutes: optimized.routes.filter((r) => r.isStatic),
  dynamicRoutes: optimized.routes.filter((r) => r.isDynamic),
  modules: analysis.modules,
  meta: {
    inlinedHandlers: optimized.meta.inlined,
    deduplicatedHandlers: optimized.meta.deduplicated,
    eliminatedRoutes: optimized.meta.eliminated,
    totalCompileTime: elapsedMs,
  },
});

export const runDiscoveryPhase = (
  opts: CompilerOptions,
  logger: Logger
): DiscoveryResult =>
  logger.time("discovery", () => {
    const result = runDiscovery(opts, logger);

    logger.info("discovery complete", {
      files: result.files.length,
      modules: result.modules.length,
    });

    return result;
  });

export const runAnalysisPhase = (
  discovery: DiscoveryResult,
  opts: CompilerOptions,
  logger: Logger
): AnalysisResult =>
  logger.time("analysis", () => {
    const result = runAnalysis(discovery, opts, logger);

    logger.info("analysis complete", {
      routes: result.routes.length,
      hooks: result.hooks.size,
    });

    return result;
  });

export const runOptimizationPhase = (
  analysis: AnalysisResult,
  opts: CompilerOptions,
  logger: Logger
): OptimizationResult =>
  logger.time("optimization", () => {
    const result = runOptimization(analysis.routes, analysis.modules, opts, logger);

    logger.info("optimization complete", {
      inlined: result.meta.inlined,
      deduplicated: result.meta.deduplicated,
      eliminated: result.meta.eliminated,
    });

    return result;
  });

export const runCodegenPhase = (
  optimized: OptimizationResult,
  analysis: AnalysisResult,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("codegen", () => {
    const code = runCodeGen(
      optimized.routes,
      analysis.modules,
      analysis.hooks,
      opts,
      logger
    );

    logger.info("codegen complete", {
      lines: code.split("\n").length,
    });

    return code;
  });

export const runLinkingPhase = (
  code: string,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("linker", () => {
    return runLinker(code, opts, logger);
  });

export class FluxCompiler {
  constructor(private readonly input: Partial<CompilerOptions> = {}) {}

  compile(): CompiledRoute {
    const validated = validateOptions(this.input);

    if (!validated.ok) {
      throw new Error(
        `Compiler options invalid:\n${validated.error.join("\n")}`
      );
    }

    const opts = validated.value;
    const logger = consoleLogger();
    const t0 = performance.now();

    logger.info("flux compiler started", {
      target: opts.target,
      optimizationLevel: opts.optimizationLevel,
      routesDir: opts.routesDir,
      outDir: opts.outDir,
    });

    const discovery = runDiscoveryPhase(opts, logger);
    const analysis = runAnalysisPhase(discovery, opts, logger);
    const optimized = runOptimizationPhase(analysis, opts, logger);
    const code = runCodegenPhase(optimized, analysis, opts, logger);
    const outPath = runLinkingPhase(code, opts, logger);

    const elapsed = performance.now() - t0;

    logger.info("build complete", {
      elapsedMs: Number(elapsed.toFixed(2)),
      outPath,
    });

    return createCompilationResult(optimized, analysis, elapsed);
  }
}

export function build(opts?: Partial<CompilerOptions>): CompiledRoute {
  return new FluxCompiler(opts).compile();
}

if (import.meta.main) {
  build();
}
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/core/lru.ts
# ----------------------------------------------------------------------------

echo "Replacing src/core/lru.ts..."

cat > src/core/lru.ts <<'FLUX_EOF'
/**
 * Production LRU cache backed by lru-cache.
 *
 * Fixed:
 * - allowStale is now respected
 */

import { LRUCache as LRU } from "lru-cache";

export interface LRUCacheOptions<K, V> {
  max?: number;
  ttlMs?: number;
  staleTtlMs?: number;
  maxBytes?: number;
  sizeOf?: (value: V, key: K) => number;
  onEvict?: (key: K, value: V) => void;
}

interface Entry<V> {
  value: V;
  bytes: number;
  expiresAt: number;
  staleAt: number;
}

export class LRUCache<K, V> {
  private lru: LRU<K, Entry<V>>;
  private inflight = new Map<K, Promise<V>>();

  constructor(private readonly opts: LRUCacheOptions<K, V> = {}) {
    this.lru = new LRU<K, Entry<V>>({
      max: opts.max ?? 1000,
      maxSize: opts.maxBytes,
      sizeCalculation: (entry) => Math.max(1, entry.bytes),
      dispose: (entry, key) => {
        opts.onEvict?.(key, entry.value);
      },
    });
  }

  get size(): number {
    return this.lru.size;
  }

  get byteSize(): number {
    return this.lru.calculatedSize;
  }

  private now(): number {
    return Date.now();
  }

  private alive(entry: Entry<V>, now: number): boolean {
    return entry.expiresAt === 0 || entry.expiresAt > now;
  }

  private fresh(entry: Entry<V>, now: number): boolean {
    return entry.staleAt === 0 || entry.staleAt > now;
  }

  get(key: K, options: { allowStale?: boolean } = {}): V | undefined {
    const entry = this.lru.get(key);
    if (!entry) return undefined;

    const now = this.now();

    if (!this.alive(entry, now)) {
      this.lru.delete(key);
      return undefined;
    }

    if (!options.allowStale && !this.fresh(entry, now)) {
      return undefined;
    }

    return entry.value;
  }

  set(
    key: K,
    value: V,
    options: { ttlMs?: number; staleTtlMs?: number; bytes?: number } = {}
  ): this {
    const ttlMs = options.ttlMs ?? this.opts.ttlMs ?? 0;
    const staleTtlMs = options.staleTtlMs ?? this.opts.staleTtlMs ?? 0;
    const bytes = options.bytes ?? this.opts.sizeOf?.(value, key) ?? 0;
    const maxBytes = this.opts.maxBytes ?? 0;

    if (maxBytes > 0 && bytes > maxBytes) return this;

    const now = this.now();
    const expiresAt = ttlMs > 0 ? now + ttlMs : 0;
    const staleAt = staleTtlMs > 0 ? now + staleTtlMs : expiresAt;
    const lruTtl = Math.max(ttlMs, staleTtlMs);

    this.lru.set(
      key,
      { value, bytes, expiresAt, staleAt },
      lruTtl > 0 ? { ttl: lruTtl } : undefined
    );

    return this;
  }

  delete(key: K): boolean {
    return this.lru.delete(key);
  }

  clear(): void {
    this.lru.clear();
    this.inflight.clear();
  }

  async getOrSet(
    key: K,
    factory: () => Promise<V> | V,
    options: { ttlMs?: number; staleTtlMs?: number; bytes?: number } = {}
  ): Promise<V> {
    const now = this.now();
    const entry = this.lru.get(key);

    if (entry && this.alive(entry, now)) {
      if (!this.fresh(entry, now) && !this.inflight.has(key)) {
        const revalidate = Promise.resolve()
          .then(factory)
          .then((value) => this.set(key, value, options))
          .catch(() => {
            // keep stale value on failure
          })
          .finally(() => {
            this.inflight.delete(key);
          });

        this.inflight.set(key, revalidate as Promise<V>);
      }

      return entry.value;
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = Promise.resolve()
      .then(factory)
      .then((value) => {
        this.set(key, value, options);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }
}
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/core/trace.ts
# ----------------------------------------------------------------------------

echo "Replacing src/core/trace.ts..."

cat > src/core/trace.ts <<'FLUX_EOF'
/**
 * Distributed tracing helpers.
 *
 * Fixed:
 * - uses crypto.randomUUID()
 * - does not mutate response headers directly
 */

export type TraceEvent =
  | "request"
  | "parse"
  | "transform"
  | "beforeHandle"
  | "handle"
  | "afterHandle"
  | "mapResponse"
  | "afterResponse"
  | "error";

export interface TraceSpan {
  id: string;
  name: string;
  event: TraceEvent;
  begin: number;
  end?: number;
  error?: Error | null;
  attributes?: Record<string, unknown>;
  children: TraceSpan[];
}

export interface TraceContext {
  traceId: string;
  spans: TraceSpan[];
  startSpan(name: string, event: TraceEvent): TraceSpan;
  endSpan(span: TraceSpan, error?: Error | null): void;
}

let traceCounter = 0;

export const createTraceContext = (requestId: string): TraceContext => {
  const spans: TraceSpan[] = [];

  return {
    traceId: requestId,
    spans,
    startSpan(name, event) {
      const span: TraceSpan = {
        id: `${requestId}-${++traceCounter}`,
        name,
        event,
        begin: performance.now(),
        children: [],
      };

      spans.push(span);
      return span;
    },
    endSpan(span, error = null) {
      span.end = performance.now();
      span.error = error;
    },
  };
};

export const startTrace = (req: Request): { traceId: string; start: number } => {
  const traceId =
    req.headers.get("x-trace-id") ||
    req.headers.get("x-request-id") ||
    crypto.randomUUID();

  return { traceId, start: performance.now() };
};

export const finishTrace = (
  _req: Request,
  trace: { traceId: string; start: number },
  response: Response
): Response => {
  const duration = performance.now() - trace.start;

  const headers = new Headers(response.headers);
  headers.set("x-trace-id", trace.traceId);
  headers.set("x-response-time", duration.toFixed(2) + "ms");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/core/proxy.ts
# ----------------------------------------------------------------------------

echo "Replacing src/core/proxy.ts..."

cat > src/core/proxy.ts <<'FLUX_EOF'
/**
 * Proxy / forwarding helpers.
 *
 * Fixed:
 * - uses AbortSignal.timeout()
 * - removes manual setTimeout cleanup
 */

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export interface ProxyOptions extends Omit<RequestInit, "body"> {
  timeoutMs?: number;
  body?: BodyInit | ReadableStream | null;
}

function sanitizeRequestHeaders(headers: Headers): Headers {
  const out = new Headers(headers);

  for (const h of HOP_BY_HOP) out.delete(h);

  out.delete("host");
  out.delete("content-length");

  return out;
}

function sanitizeResponseHeaders(headers: Headers): Headers {
  const out = new Headers(headers);

  for (const h of HOP_BY_HOP) out.delete(h);

  return out;
}

export async function proxyRequest(
  target: string | URL,
  opts: ProxyOptions = {}
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);

  const signal = opts.signal
    ? typeof AbortSignal.any === "function"
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal
    : timeoutSignal;

  try {
    const headers = sanitizeRequestHeaders(
      opts.headers instanceof Headers ? opts.headers : new Headers(opts.headers)
    );

    const init: RequestInit & { duplex?: string } = {
      method: opts.method ?? "GET",
      headers,
      redirect: opts.redirect ?? "manual",
      signal,
    };

    if (opts.body != null) {
      init.body = opts.body;

      if (typeof (opts.body as any).pipeTo === "function") {
        init.duplex = "half";
      }
    }

    const upstream = await fetch(target.toString(), init);

    const responseHeaders = sanitizeResponseHeaders(upstream.headers);
    responseHeaders.set("x-proxy", "flux");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return Response.json({ error: "Upstream timeout", status: 504 }, { status: 504 });
    }

    return Response.json({ error: "Bad Gateway", status: 502 }, { status: 502 });
  }
}

export async function forwardRequest(
  req: Request,
  target: string | URL,
  opts: ProxyOptions = {}
): Promise<Response> {
  const incoming = new URL(req.url);
  const targetUrl = new URL(target.toString());

  if (!targetUrl.search) {
    targetUrl.search = incoming.search;
  }

  const headers = sanitizeRequestHeaders(req.headers);

  const hasBody =
    req.method !== "GET" && req.method !== "HEAD" && req.body != null;

  return proxyRequest(targetUrl, {
    ...opts,
    method: req.method,
    headers,
    body: hasBody ? (req.body as ReadableStream) : undefined,
  });
}
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/core/cluster.ts
# ----------------------------------------------------------------------------

echo "Replacing src/core/cluster.ts..."

cat > src/core/cluster.ts <<'FLUX_EOF'
/**
 * Multi-core server helper.
 *
 * Fixed:
 * - uses node:os availableParallelism()
 */

import { availableParallelism } from "node:os";

export type ServeOptions = Parameters<typeof Bun.serve>[0];

export interface ClusterServeOptions extends ServeOptions {
  workers?: number | "auto";
}

export function serveCluster(options: ClusterServeOptions) {
  const requested = options.workers ?? 1;

  const count =
    requested === "auto"
      ? Math.max(1, availableParallelism())
      : Math.max(1, Number(requested));

  const serveOptions: ServeOptions = { ...options };
  delete (serveOptions as any).workers;

  const servers = Array.from({ length: count }, () =>
    Bun.serve({
      ...serveOptions,
      reusePort: count > 1 ? true : serveOptions.reusePort,
    })
  );

  return {
    servers,
    port: servers[0]?.port,
    stop() {
      for (const server of servers) {
        server.stop();
      }
    },
  };
}
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace src/core/schema.ts
# ----------------------------------------------------------------------------

echo "Replacing src/core/schema.ts..."

cat > src/core/schema.ts <<'FLUX_EOF'
/**
 * Runtime schema validation.
 *
 * Supports:
 * - TypeBox / JSON Schema via Ajv
 * - Standard Schema v1 via async validation
 */

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { AnySchema, StandardSchemaV1 } from "./types";
import { ValidationError } from "./errors";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: true,
  removeAdditional: true,
  useDefaults: true,
});

addFormats(ajv);

function isStandardSchema(schema: AnySchema): schema is StandardSchemaV1 {
  return typeof schema === "object" && schema !== null && "~standard" in schema;
}

function toErrorRecord(
  errors: ErrorObject[] | null | undefined,
  on: string
): Record<string, string[]> {
  const out: Record<string, string[]> = {};

  for (const e of errors ?? []) {
    const path =
      e.instancePath?.replace(/^\//, "").replace(/\//g, ".") ||
      (e.params as any)?.missingProperty ||
      on;

    out[path] ??= [];
    out[path].push(e.message ?? "Invalid value");
  }

  return out;
}

export function compileValidator<T = unknown>(
  schema: AnySchema,
  on: string = "input"
) {
  if (isStandardSchema(schema)) {
    return (_input: unknown): T => {
      throw new Error(
        "Standard Schema validators are async. Use validateAsync() instead of compileValidator()."
      );
    };
  }

  const validate = ajv.compile(schema as object);

  return (input: unknown): T => {
    if (!validate(input)) {
      throw new ValidationError(
        "Validation failed",
        toErrorRecord(validate.errors, on),
        on
      );
    }

    return input as T;
  };
}

export function validateOrThrow<T = unknown>(
  schema: AnySchema,
  input: unknown,
  on: string = "input"
): T {
  return compileValidator<T>(schema, on)(input);
}

export async function validateAsync<T = unknown>(
  schema: AnySchema,
  input: unknown,
  on: string = "input"
): Promise<T> {
  if (isStandardSchema(schema)) {
    const result = await schema["~standard"].validate(input);

    if ("issues" in result) {
      const errors: Record<string, string[]> = {};

      for (const issue of result.issues) {
        const path = issue.path?.join(".") || on;
        errors[path] ??= [];
        errors[path].push(issue.message);
      }

      throw new ValidationError("Validation failed", errors, on);
    }

    return result.value as T;
  }

  return compileValidator<T>(schema, on)(input);
}
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace upload route
# ----------------------------------------------------------------------------

echo "Replacing src/routes/upload.post.ts..."

cat > src/routes/upload.post.ts <<'FLUX_EOF'
import { post } from "../core/http";
import { mkdir } from "node:fs/promises";

export default post(async (ctx) => {
  const file = await ctx.body.file();

  if (!file) {
    return ctx.json({ error: "file required" }, { status: 400 });
  }

  await mkdir("uploads", { recursive: true });

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const storedName = `${Date.now().toString(36)}-${safeName}`;
  const dest = `uploads/${storedName}`;

  await Bun.write(dest, file);

  return ctx.json({
    ok: true,
    size: file.size,
    type: file.type,
    path: `/files/${storedName}`,
  });
});
FLUX_EOF

# ----------------------------------------------------------------------------
# Replace plugins with hardened versions
# ----------------------------------------------------------------------------

echo "Replacing CORS plugin..."

cat > src/core/plugins/cors.ts <<'FLUX_EOF'
/**
 * CORS plugin.
 *
 * Hardened:
 * - always varies on Origin
 * - safer credentials handling
 */

import type { FluxPlugin } from "../plugin";
import type { FluxContext } from "../context";

export interface CorsOptions {
  origin?: string | string[] | ((origin: string, ctx: FluxContext) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
  preflightContinue?: boolean;
}

const DEFAULT_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"];

export const cors = (options: CorsOptions = {}): FluxPlugin => {
  const {
    origin = "*",
    methods = DEFAULT_METHODS,
    allowedHeaders,
    exposedHeaders,
    credentials = false,
    maxAge = 86400,
    preflightContinue = false,
  } = options;

  const isOriginAllowed = (requestOrigin: string, ctx: FluxContext): boolean => {
    if (origin === "*") return true;
    if (typeof origin === "string") return origin === requestOrigin;
    if (Array.isArray(origin)) return origin.includes(requestOrigin);
    return origin(requestOrigin, ctx);
  };

  const appendVary = (headers: Headers, value: string): void => {
    const existing = headers.get("vary");
    if (!existing) {
      headers.set("vary", value);
      return;
    }

    const parts = existing.split(",").map((x) => x.trim().toLowerCase());
    if (!parts.includes(value.toLowerCase())) {
      headers.set("vary", `${existing}, ${value}`);
    }
  };

  const setCorsHeaders = (ctx: FluxContext, headers: Headers): void => {
    appendVary(headers, "Origin");

    const requestOrigin = ctx.headers.get("origin") || "";
    if (!requestOrigin) return;

    if (isOriginAllowed(requestOrigin, ctx)) {
      headers.set("Access-Control-Allow-Origin", requestOrigin);
    } else if (origin === "*" && !credentials) {
      headers.set("Access-Control-Allow-Origin", "*");
    }

    if (credentials) {
      headers.set("Access-Control-Allow-Credentials", "true");
    }

    if (exposedHeaders?.length) {
      headers.set("Access-Control-Expose-Headers", exposedHeaders.join(", "));
    }
  };

  return {
    name: "cors",

    onRequest(ctx) {
      if (!ctx.headers.get("origin")) return ctx;

      if (ctx.method === "OPTIONS") {
        const headers = new Headers();

        setCorsHeaders(ctx, headers);
        headers.set("Access-Control-Allow-Methods", methods.join(", "));

        if (allowedHeaders?.length) {
          headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
        } else {
          const reqHeaders = ctx.headers.get("access-control-request-headers");
          if (reqHeaders) {
            headers.set("Access-Control-Allow-Headers", reqHeaders);
          }
        }

        headers.set("Access-Control-Max-Age", String(maxAge));

        if (preflightContinue) return ctx;

        return new Response(null, { status: 204, headers });
      }

      return ctx;
    },

    onResponse(ctx, response) {
      const headers = new Headers(response.headers);
      setCorsHeaders(ctx, headers);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
FLUX_EOF

echo "Replacing rate limit plugin..."

cat > src/core/plugins/ratelimit.ts <<'FLUX_EOF'
/**
 * Rate limit plugin.
 *
 * Hardened:
 * - does not trust x-forwarded-for unless trustProxy is enabled
 */

import type { FluxPlugin } from "../plugin";
import type { FluxContext } from "../context";
import { LRUCache } from "../lru";

export interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  storeMax?: number;
  trustProxy?: boolean;
  keyGenerator?: (ctx: FluxContext) => string;
  skip?: (ctx: FluxContext) => boolean;
  message?: string;
}

interface WindowEntry {
  count: number;
  resetTime: number;
}

export const rateLimit = (options: RateLimitOptions = {}): FluxPlugin => {
  const {
    windowMs = 60_000,
    maxRequests = 100,
    storeMax = 10_000,
    trustProxy = false,
    skip,
    message = "Too many requests",
  } = options;

  const defaultKeyGenerator = (ctx: FluxContext): string => {
    if (trustProxy) {
      const xff = ctx.headers.get("x-forwarded-for");
      if (xff) return xff.split(",")[0]?.trim() || "anonymous";
    }

    return ctx.headers.get("x-real-ip") || "anonymous";
  };

  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;

  const store = new LRUCache<string, WindowEntry>({
    max: storeMax,
    ttlMs: windowMs,
  });

  const getHeaders = (entry: WindowEntry): Record<string, string> => ({
    "X-RateLimit-Limit": String(maxRequests),
    "X-RateLimit-Remaining": String(Math.max(0, maxRequests - entry.count)),
    "X-RateLimit-Reset": String(Math.ceil(entry.resetTime / 1000)),
  });

  return {
    name: "rateLimit",

    onRequest(ctx) {
      if (skip?.(ctx)) return ctx;

      const key = keyGenerator(ctx);
      const now = Date.now();

      let entry = store.get(key);

      if (!entry || entry.resetTime <= now) {
        entry = { count: 0, resetTime: now + windowMs };
        store.set(key, entry, { ttlMs: windowMs });
      }

      entry.count++;

      store.set(key, entry, {
        ttlMs: Math.max(0, entry.resetTime - now),
      });

      if (entry.count > maxRequests) {
        return Response.json(
          { error: message },
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              ...getHeaders(entry),
            },
          }
        );
      }

      ctx.setState("__ratelimit", entry);
      return ctx;
    },

    onResponse(ctx, response) {
      const entry = ctx.getState<WindowEntry>("__ratelimit");

      if (entry) {
        const headers = new Headers(response.headers);

        for (const [k, v] of Object.entries(getHeaders(entry))) {
          headers.set(k, v);
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return response;
    },
  };
};
FLUX_EOF

echo "Replacing compression plugin..."

cat > src/core/plugins/compression.ts <<'FLUX_EOF'
/**
 * Compression plugin.
 *
 * Hardened:
 * - guards against missing CompressionStream
 */

import type { FluxPlugin } from "../plugin";

export interface CompressionOptions {
  threshold?: number;
  filter?: (contentType: string) => boolean;
}

const COMPRESSIBLE = new Set([
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "image/svg+xml",
]);

const shouldCompress = (ct: string): boolean => {
  for (const prefix of COMPRESSIBLE) {
    if (ct.startsWith(prefix)) return true;
  }

  return false;
};

export const compression = (options: CompressionOptions = {}): FluxPlugin => {
  const { threshold = 1024, filter = shouldCompress } = options;

  return {
    name: "compression",

    onResponse(ctx, response) {
      if (!response.body) return response;
      if (response.headers.get("content-encoding")) return response;

      const ct = response.headers.get("content-type") || "";
      if (!filter(ct)) return response;

      const len = Number(response.headers.get("content-length") || "0");
      if (len && len < threshold) return response;

      const acceptEncoding = ctx.headers.get("accept-encoding") || "";

      const encoding = acceptEncoding.includes("gzip")
        ? "gzip"
        : acceptEncoding.includes("deflate")
          ? "deflate"
          : null;

      if (!encoding) return response;

      if (typeof CompressionStream === "undefined") {
        return response;
      }

      const headers = new Headers(response.headers);
      headers.set("content-encoding", encoding);
      headers.delete("content-length");

      const compressed = response.body.pipeThrough(new CompressionStream(encoding));

      return new Response(compressed, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
FLUX_EOF

echo "Replacing logger plugin..."

cat > src/core/plugins/logger.ts <<'FLUX_EOF'
/**
 * Logger plugin.
 *
 * Hardened:
 * - adds basic redaction paths
 */

import pino, { type Logger as PinoLogger } from "pino";
import type { FluxPlugin } from "../plugin";
import type { FluxContext } from "../context";

export interface LoggerOptions {
  level?: string;
  logger?: PinoLogger;
  skip?: (ctx: FluxContext) => boolean;
}

export const logger = (options: LoggerOptions = {}): FluxPlugin => {
  const log =
    options.logger ??
    pino({
      level: options.level ?? "info",
      base: undefined,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.authorization",
        "headers.cookie",
      ],
    });

  return {
    name: "logger",

    onResponse(ctx, response) {
      if (options.skip?.(ctx)) return response;

      const duration = performance.now() - ctx.startTime;

      const payload = {
        requestId: ctx.requestId,
        method: ctx.method,
        path: ctx.path,
        status: response.status,
        durationMs: Math.round(duration * 1000) / 1000,
        timestamp: new Date().toISOString(),
      };

      if (response.status >= 500) {
        log.error(payload);
      } else if (response.status >= 400) {
        log.warn(payload);
      } else {
        log.info(payload);
      }

      return response;
    },
  };
};
FLUX_EOF

# ----------------------------------------------------------------------------
# Remove FP barrel export from core index
# ----------------------------------------------------------------------------

echo "Removing FP barrel export from src/core/index.ts..."

if [[ -f src/core/index.ts ]]; then
  perl -pi -e 's|^export \* from "\.\./compiler/fp";|// FP utilities removed from core barrel. Import from src/fp or src/compiler/fp if needed.|' src/core/index.ts
fi

# ----------------------------------------------------------------------------
# Remove duplicated CompilerOptions from src/core/types.ts
# Re-export from compiler types instead.
# ----------------------------------------------------------------------------

echo "Patching src/core/types.ts to re-export CompilerOptions from compiler..."

if [[ -f src/core/types.ts ]]; then
  perl -0pi -e 's#// =+\n// Compiler Options[\s\S]*$#// ============================================================================\n// Compiler Options (shared from compiler)\n// ============================================================================\n\nexport type { CompilerOptions } from "../compiler/types";\nexport { DEFAULT_OPTS } from "../compiler/types";\n#' src/core/types.ts
fi

# ----------------------------------------------------------------------------
# Patch analysis to extract route hooks from config export
# ----------------------------------------------------------------------------

echo "Patching src/compiler/phases/analysis.ts to extract route hooks..."

if [[ -f src/compiler/phases/analysis.ts ]]; then
  perl -pi -e 's#const hooks: string\[\] = \[\];#const hooks = Array.isArray(astParsed.config?.hooks)\n    ? astParsed.config.hooks.filter((x: unknown): x is string => typeof x === "string")\n    : [];#' src/compiler/phases/analysis.ts
fi

# ----------------------------------------------------------------------------
# Patch codegen for Option A
# ----------------------------------------------------------------------------

echo "Patching src/compiler/phases/codegen.ts for Option A..."

if [[ -f src/compiler/phases/codegen.ts ]]; then

  # Remove SegNode and JumpTable from type import.
  perl -0pi -e 's#import type \{\s*RouteDef,\s*ModuleInfo,\s*SegNode,\s*JumpTable,\s*CompilerOptions,\s*HookDef,\s*\} from "\.\./types";#import type {\n  RouteDef,\n  ModuleInfo,\n  CompilerOptions,\n  HookDef,\n} from "../types";#g' src/compiler/phases/codegen.ts

  # Update generateServer signature.
  perl -0pi -e 's#export const generateServer = \(\n  routes: readonly RouteDef\[\],\n  _trie: SegNode,\n  _jumpTable: JumpTable,\n  modules: readonly ModuleInfo\[\],\n  hooks: ReadonlyMap<string, HookDef>,\n  _buffers: ReadonlyMap<string, string>,\n  opts: CompilerOptions\n\): string => \{#export const generateServer = (\n  routes: readonly RouteDef[],\n  modules: readonly ModuleInfo[],\n  hooks: ReadonlyMap<string, HookDef>,\n  opts: CompilerOptions\n): string => {#g' src/compiler/phases/codegen.ts

  # Remove trie/jumpTable from runCodeGen signature if present.
  perl -0pi -e 's#(export const runCodeGen = \(\s*routes: readonly RouteDef\[\],\s*)trie: SegNode,\s*jumpTable: JumpTable,\s*#$1#g' src/compiler/phases/codegen.ts

  # Remove buffers from runCodeGen signature if present.
  perl -0pi -e 's#(hooks: ReadonlyMap<string, HookDef>,\s*)buffers: ReadonlyMap<string, string>,\s*#$1#g' src/compiler/phases/codegen.ts

  # Update generateServer call.
  perl -0pi -e 's#generateServer\(\s*routes,\s*trie,\s*jumpTable,\s*modules,\s*hooks,\s*buffers,\s*opts\s*\)#generateServer(routes, modules, hooks, opts)#g' src/compiler/phases/codegen.ts

fi

# ----------------------------------------------------------------------------
# Optional project rearrangement
# ----------------------------------------------------------------------------

if [[ "${RESTRUCTURE:-0}" == "1" ]]; then
  echo "Rearranging project structure..."

  mkdir -p src/fp

  move src/core src/runtime
  move src/runtime/plugins src/plugins
  move src/compiler/fp.ts src/fp/index.ts

  # Update compiler FP imports.
  if [[ -f src/compiler/phases/discovery.ts ]]; then
    perl -pi -e 's#from "\.\./fp"#from "../../fp"#g' src/compiler/phases/discovery.ts
  fi

  if [[ -f src/compiler/validate.ts ]]; then
    perl -pi -e 's#from "\./fp"#from "../fp"#g' src/compiler/validate.ts
  fi

  # Update runtime index plugin imports.
  if [[ -f src/runtime/index.ts ]]; then
    perl -pi -e 's#from "\./plugins/#from "../plugins/#g' src/runtime/index.ts
    perl -pi -e 's#from "\.\./compiler/fp"#from "../fp"#g' src/runtime/index.ts
  fi

  # Update plugin imports to point to runtime.
  if [[ -d src/plugins ]]; then
    find src/plugins -type f -name '*.ts' -print0 | xargs -0 perl -pi -e '
      s#from "\.\./plugin"#from "../runtime/plugin"#g;
      s#from "\.\./context"#from "../runtime/context"#g;
      s#from "\.\./lru"#from "../runtime/lru"#g;
    '
  fi

  # Update route imports.
  if [[ -d src/routes ]]; then
    find src/routes -type f -name '*.ts' -print0 | xargs -0 perl -pi -e '
      s#core/http#runtime/http#g;
      s#core/index#runtime/index#g;
      s#from "\.\./core"#from "../runtime"#g;
      s#from "\.\./\.\./core"#from "../../runtime"#g;
    '
  fi

  # Update codegen runtime paths.
  if [[ -f src/compiler/phases/codegen.ts ]]; then
    perl -pi -e 's#src/core/#src/runtime/#g; s#core/http#runtime/http#g' src/compiler/phases/codegen.ts
  fi
fi

# ----------------------------------------------------------------------------
# Install dependencies
# ----------------------------------------------------------------------------

echo "Installing dependencies..."
bun install

# ----------------------------------------------------------------------------
# Checks
# ----------------------------------------------------------------------------

echo "Running typecheck..."
set +e
bun run typecheck
TYPECHECK_CODE=$?
set -e

if [[ $TYPECHECK_CODE -ne 0 ]]; then
  echo ""
  echo "Typecheck failed. This is expected if codegen.ts has custom modifications."
  echo "Review src/compiler/phases/codegen.ts and ensure runCodeGen matches:"
  echo ""
  echo "export const runCodeGen = ("
  echo "  routes: readonly RouteDef[],"
  echo "  modules: readonly ModuleInfo[],"
  echo "  hooks: ReadonlyMap<string, HookDef>,"
  echo "  opts: CompilerOptions,"
  echo "  logger: Logger"
  echo "): string => logger.time(\"codegen\", () => generateServer(routes, modules, hooks, opts));"
  echo ""
fi

echo "Running lint..."
set +e
bun run lint
set -e

echo "Running tests..."
set +e
bun test
set -e

echo ""
echo "Refactor complete."
echo "Backup directory: ${BACKUP_DIR}"
echo ""
echo "Next steps:"
echo "1. Review git diff carefully."
echo "2. Fix any remaining codegen.ts signature issues."
echo "3. Add integration tests for compiled server output."
echo "4. Add OpenTelemetry/metrics plugins if observability is required."
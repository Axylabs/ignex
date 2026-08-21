/**
 * @fileoverview Incremental build cache.
 *
 * A lightweight content-hash cache: when none of the build inputs changed
 * (route files, app config, hooks, effective options, compiler version), the
 * previous build outputs are reused and the whole pipeline is skipped.
 *
 * This is a whole-build "no-op" cache (like most framework build caches), NOT
 * parse-level incremental compilation. Parse-level incremental builds are
 * future work.
 *
 * Uses `node:fs/promises` for portability across Bun and Node runtimes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { DiagnosticCodes, errorMessage } from "./diagnostics";
import { isRouteFile } from "./phases/discovery";
import type { CompilerContext, CompilerOptions, OptimizationMeta } from "./types";
import { hashString } from "./utils/hash";
import { projectPath } from "./utils/path";

/**
 * Bump when the generated output format changes so stale caches are
 * invalidated even if inputs are identical.
 */
const COMPILER_CACHE_VERSION = "0.7.7";

const CACHE_FILE = ".ignex-cache.json";

interface CacheRecord {
  readonly version: string;
  readonly fingerprint: string;
  readonly outFile: string;
  readonly timestamp: string;
  readonly meta?: OptimizationMeta;
  /** Per-route fingerprints from the build that wrote this record. */
  readonly routes?: RouteFingerprint[];
}

/** Per-route cache fingerprint: relative path + content + codegen version. */
export interface RouteFingerprint {
  readonly relPath: string;
  readonly fingerprint: string;
}

/** Route change summary derived from comparing two fingerprint sets. */
export interface RouteChangeSet {
  readonly changed: string[];
  readonly unchanged: string[];
}

const listFiles = (dir: string, base = ""): string[] => {
  const out: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;

    const abs = join(dir, entry);
    const rel = join(base, entry).replace(/\\/g, "/");

    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      out.push(...listFiles(abs, rel));
    } else {
      out.push(rel);
    }
  }

  return out;
};

const hashFile = (absPath: string): string => {
  try {
    const content = readFileSync(absPath, "utf-8");
    const stat = statSync(absPath);
    return `${hashString(content)}:${stat.mtimeMs}`;
  } catch {
    // Distinguish a DELETED file (cache miss as normal) from an unreadable one
    // (permission error, transient FS fault) so the cache never treats the
    // latter as if the file simply vanished.
    return existsSync(absPath) ? "unreadable" : "missing";
  }
};

/**
 * Companion artifacts produced alongside the server entry. On a cache hit the
 * generated server imports precompiled validators/serializers, so stale or
 * missing companions mean broken output — treat them as a cache miss.
 */
const missingCompanionArtifacts = (opts: CompilerOptions): boolean => {
  const required: string[] = ["manifest.json"];

  if (opts.generateTypes) required.push("routes.d.ts");
  if (opts.generateClient) required.push("client.ts", "client.d.ts");
  if (opts.generateOpenAPI) required.push("openapi.json");
  if (opts.precompileValidators) required.push("validators");
  if (opts.precompileSerializers) required.push("serializers");

  return required.some((rel) => !existsSync(join(opts.outDir, rel)));
};

const stableOptions = (opts: CompilerOptions): string => {
  const keys = Object.keys(opts).sort();
  const parts: string[] = [];

  for (const key of keys) {
    const value = (opts as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // Functions serialize as `undefined` under plain JSON.stringify — two
    // builds with different function-valued options (filter/onError/transform
    // callbacks) would collide on the same fingerprint and the cache could
    // serve the PREVIOUS build's output. Include the function source so a
    // behavior change is a fingerprint change.
    parts.push(
      `${key}=${JSON.stringify(value, (_k, v) => (typeof v === "function" ? `[fn:${v.toString()}]` : v))}`,
    );
  }

  return parts.join("&");
};

/**
 * Resolve the on-disk `@ignex/core` package directory so its shipped source can
 * be fingerprinted. The linker bundles `@ignex/core` into the output, so a core
 * source change must invalidate the cache even when routes/hooks/config are
 * unchanged.
 */
const corePackageDir = (): string | undefined => {
  const req = createRequire(import.meta.url);

  // Installed layout: node_modules/@ignex/core/package.json (via exports).
  try {
    return dirname(req.resolve("@ignex/core/package.json"));
  } catch {
    // Workspace/source layout (no node_modules symlinks): resolve the main
    // entry (<root>/src/index.ts) and climb to the package root.
    try {
      const entry = req.resolve("@ignex/core");
      const root = dirname(dirname(entry)); // <root>/src → <root>
      return existsSync(join(root, "package.json")) ? root : undefined;
    } catch {
      return undefined;
    }
  }
};

/**
 * Compute the whole-build content fingerprint used by the incremental cache.
 *
 * Mixes the compiler cache version, the stable option projection, and the
 * content hashes of every file under `routesDir`/`hooksDir` plus the app
 * config. Two builds with the same fingerprint are guaranteed to emit
 * identical output, so a cache hit is safe.
 *
 * @param opts - The validated compiler options.
 * @returns A stable content fingerprint string.
 */
export const computeFingerprint = (opts: CompilerOptions): string => {
  // NOTE: the fingerprint DELIBERATELY excludes most of the environment
  // (IGNEX_NATIVE, IGNEX_FFI_MODE, PORT, …). Generated code is env-
  // independent: native degrades at RUNTIME, not at codegen, and PORT is read
  // at runtime via `process.env.PORT`. Do NOT add env vars here without also
  // proving the generated output depends on them — a future "generate
  // native-specific code" feature must bump COMPILER_CACHE_VERSION instead
  // (see scripts/check-cache-versions.ts).
  //
  // EXCEPTION — NODE_ENV and IGNEX_DEBUG DO change generated output: the
  // dev-only plugin elimination (`isProductionBuild` in
  // phases/analysis/app-config.ts) drops provably-disabled `debugbar()`
  // instances from the AOT decision, which changes route shapes (constant
  // hoisting, context specialization). A production build must never poison
  // the dev cache with eliminated routes (and vice versa), so both values
  // are part of the fingerprint.
  const chunks: string[] = [
    COMPILER_CACHE_VERSION,
    stableOptions(opts),
    `env:NODE_ENV=${process.env.NODE_ENV ?? ""}`,
    `env:IGNEX_DEBUG=${process.env.IGNEX_DEBUG ?? ""}`,
  ];

  const hashDir = (dir: string) => {
    for (const rel of listFiles(dir)) {
      chunks.push(`${rel}:${hashFile(join(dir, rel))}`);
    }
  };

  if (opts.routesDir && existsSync(opts.routesDir)) {
    hashDir(opts.routesDir);
  }

  if (opts.hooksDir && existsSync(opts.hooksDir)) {
    hashDir(opts.hooksDir);
  }

  if (opts.appConfig) {
    chunks.push(`appConfig:${hashFile(projectPath(opts.appConfig))}`);
  }

  const core = corePackageDir();
  if (core && existsSync(core)) {
    chunks.push(`core:${hashFile(join(core, "package.json"))}`);
    const coreSrc = join(core, "src");
    if (existsSync(coreSrc)) {
      for (const rel of listFiles(coreSrc)) {
        chunks.push(`core/src/${rel}:${hashFile(join(coreSrc, rel))}`);
      }
    }
  }

  return hashString(chunks.join("\n"));
};

// ---------------------------------------------------------------------------
// Route-granular fingerprints (parse-level incrementality foundation)
// ---------------------------------------------------------------------------

/**
 * Content-keyed fingerprint for a single route file. The codegen version is
 * mixed in so a codegen change invalidates every route even when contents are
 * identical; options are intentionally NOT mixed in — option drift already
 * invalidates the whole-build fingerprint, and this fingerprint exists purely
 * to isolate which route contents changed.
 */
export const computeRouteFingerprint = (
  relPath: string,
  source: string,
  version: string = COMPILER_CACHE_VERSION,
): string => hashString([version, relPath, source].join("\n"));

/** Hash a route file's raw content (no mtime — stable across identical files). */
const hashRouteContent = (absPath: string): string => {
  try {
    return hashString(readFileSync(absPath, "utf-8"));
  } catch {
    return "missing";
  }
};

/**
 * Scan the routes directory and fingerprint every route source file, sorted
 * by relative path so the set is deterministic regardless of FS order.
 */
export const fingerprintRouteFiles = (opts: CompilerOptions): RouteFingerprint[] => {
  if (!opts.routesDir || !existsSync(opts.routesDir)) return [];

  const out: RouteFingerprint[] = [];
  for (const rel of listFiles(opts.routesDir)) {
    if (!isRouteFile(rel)) continue;
    out.push({
      relPath: rel,
      fingerprint: computeRouteFingerprint(rel, hashRouteContent(join(opts.routesDir, rel))),
    });
  }

  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
};

/**
 * Compare two fingerprint sets and classify each route as changed or
 * unchanged. Order-independent: both sets are keyed by relative path, and a
 * route present in exactly one set counts as changed (added or deleted).
 */
export const diffRouteFingerprints = (
  prev: readonly RouteFingerprint[],
  current: readonly RouteFingerprint[],
): RouteChangeSet => {
  const prevByPath = new Map(prev.map((r) => [r.relPath, r.fingerprint]));
  const currentByPath = new Map(current.map((r) => [r.relPath, r.fingerprint]));

  const changed: string[] = [];
  const unchanged: string[] = [];

  const allPaths = new Set<string>([...prevByPath.keys(), ...currentByPath.keys()]);
  for (const relPath of allPaths) {
    if (prevByPath.get(relPath) === currentByPath.get(relPath)) {
      unchanged.push(relPath);
    } else {
      changed.push(relPath);
    }
  }

  changed.sort();
  unchanged.sort();
  return { changed, unchanged };
};

/**
 * Diff the current routes directory against the routes recorded in the last
 * stored cache. Returns `undefined` when there is no cached route fingerprint
 * set (e.g. the cache predates route fingerprinting) or no cache exists.
 */
export const computeRouteChanges = (opts: CompilerOptions): RouteChangeSet | undefined => {
  const record = readCache(opts);
  if (!record?.routes) return undefined;
  return diffRouteFingerprints(record.routes, fingerprintRouteFiles(opts));
};

const cachePath = (opts: CompilerOptions): string => join(opts.outDir, CACHE_FILE);

const readCache = (opts: CompilerOptions): CacheRecord | undefined => {
  const file = cachePath(opts);
  if (!existsSync(file)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as CacheRecord;
    return parsed && parsed.version === COMPILER_CACHE_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Returns the cached build (code + outFile) when inputs are unchanged and the
 * previous output still exists on disk, otherwise `undefined`.
 */
export const tryCachedBuild = async (
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<{ code: string; outFile: string; meta?: OptimizationMeta } | undefined> => {
  try {
    const record = readCache(opts);
    if (!record) return undefined;

    const fingerprint = computeFingerprint(opts);
    if (record.fingerprint !== fingerprint) return undefined;

    const outFile = join(opts.outDir, record.outFile);
    if (!existsSync(outFile)) return undefined;

    // A server entry whose validators/serializers/artifacts were deleted is
    // broken output — rebuild rather than serving stale imports.
    if (missingCompanionArtifacts(opts)) {
      ctx.logger.info("Incremental cache miss — companion artifacts missing or stale.");
      return undefined;
    }

    const code = await readFile(outFile, "utf-8");
    ctx.logger.info(`Incremental cache hit — skipping build (${record.outFile}).`);

    return { code, outFile, ...(record.meta ? { meta: record.meta } : {}) };
  } catch (error) {
    ctx.diagnostics.warn({
      code: DiagnosticCodes.BuildCacheInvalid,
      message: `Build cache could not be read: ${errorMessage(error)}`,
    });
    return undefined;
  }
};

/** Persist the current build's fingerprint so the next build can be skipped. */
export const storeCache = async (
  opts: CompilerOptions,
  ctx: CompilerContext,
  outPath: string,
  meta?: OptimizationMeta,
): Promise<void> => {
  try {
    const record: CacheRecord = {
      version: COMPILER_CACHE_VERSION,
      fingerprint: computeFingerprint(opts),
      outFile: relative(opts.outDir, outPath).replace(/\\/g, "/"),
      timestamp: new Date().toISOString(),
      routes: fingerprintRouteFiles(opts),
      ...(meta ? { meta } : {}),
    };

    // Atomic write (temp + rename): a crash or a second concurrent build
    // (dev watcher + `ignex build`) can never leave a truncated .json that a
    // reader half-parses — the rename is atomic, so readers see either the
    // old file or the complete new one.
    const path = cachePath(opts);
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    await rename(tmp, path);
  } catch (error) {
    ctx.diagnostics.warn({
      code: DiagnosticCodes.BuildCacheInvalid,
      message: `Failed to write build cache: ${errorMessage(error)}`,
    });
  }
};
